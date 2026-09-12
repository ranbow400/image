"""Civitai 风格生成页面后端 v3：桥接 ComfyUI（队列/收藏/clip skip/VAE/ControlNet/hires fix）"""
import json
import os
import random
import re
import subprocess
import threading
import time
import uuid
import urllib.request
from io import BytesIO

from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.utils import secure_filename

try:
    import websocket  # websocket-client：监听 ComfyUI 进度消息
except Exception:
    websocket = None

COMFY = "http://127.0.0.1:8188"
app = Flask(__name__, static_folder="static", template_folder="templates")

# ---------- 访问密码（防外人用工作台）----------
# ON_SERVER 时读 /root/autodl-tmp/genui_pass.txt，存在且非空则启用登录验证
# 本地模式不启用；改密码 = 改服务器上该文件内容后重启
def _load_auth_password():
    # 环境变量优先（测试/部署用），其次服务器密码文件；本地模式无文件则不启用
    env = os.environ.get("GENUI_PASSWORD", "")
    if env:
        return env.strip()
    if not os.path.exists("/root/autodl-tmp/ComfyUI"):
        return ""
    try:
        with open("/root/autodl-tmp/genui_pass.txt", "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""

AUTH_PASSWORD = _load_auth_password()
AUTH_COOKIE = "genui_auth"

@app.before_request
def auth_gate():
    if not AUTH_PASSWORD:
        return None
    if request.path == "/api/login" or request.path.startswith("/static") or request.method == "OPTIONS":
        return None
    if request.cookies.get(AUTH_COOKIE) == AUTH_PASSWORD:
        return None
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": "unauthorized"}), 401
    return render_template("login.html"), 401

@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json(silent=True) or {}
    if data.get("password") == AUTH_PASSWORD:
        resp = jsonify({"ok": True})
        resp.set_cookie(AUTH_COOKIE, AUTH_PASSWORD, max_age=30 * 24 * 3600,
                        httponly=True, samesite="Lax")
        return resp
    return jsonify({"ok": False, "error": "wrong password"}), 401

# 服务器直跑模式：直接本地操作文件，无需 SSH
ON_SERVER = os.path.exists("/root/autodl-tmp/ComfyUI")
SERVER_BASE = "/root/autodl-tmp/ComfyUI"
SSH_KEY = os.path.expanduser(r"~/.ssh/id_ed25519")
SSH_TARGET = "connect.westc.seetacloud.com"
SSH_PORT = "52096"

# ---------- 任务队列 ----------
TASKS = {}  # id -> {status, payload, images, error, created}
TASK_LOCK = threading.Lock()
TASK_ORDER = []  # FIFO id 列表
COND = threading.Condition()
TRIGGER_CACHE = {"data": None, "ts": 0}
# 收藏存储：放 genui 目录外（数据盘根），重新部署不影响它
FAVS_FILE = "/root/autodl-tmp/favs.json" if ON_SERVER else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "favs.json")
# 任务记录持久化：重启/部署不丢历史任务
TASKS_FILE = "/root/autodl-tmp/tasks.json" if ON_SERVER else os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "tasks.json")


def save_tasks():
    try:
        with open(TASKS_FILE, "w", encoding="utf-8") as f:
            json.dump({"order": TASK_ORDER, "tasks": TASKS}, f, ensure_ascii=False)
    except Exception:
        pass


def load_tasks():
    global TASK_ORDER
    try:
        with open(TASKS_FILE, encoding="utf-8") as f:
            d = json.load(f)
        TASK_ORDER = [i for i in d.get("order", []) if i in d.get("tasks", {})]
        for tid, t in d.get("tasks", {}).items():
            if t.get("status") in ("queued", "running"):
                t["status"] = "error"
                t["error"] = "服务重启，任务中断"
            TASKS[tid] = t
        TASK_ORDER = [i for i in TASK_ORDER if TASKS[i]["status"] not in ("queued", "running")]
    except Exception:
        pass


def load_favs():
    try:
        with open(FAVS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_favs(favs):
    with open(FAVS_FILE, "w", encoding="utf-8") as f:
        json.dump(favs[:200], f, ensure_ascii=False, indent=1)


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,DELETE,OPTIONS"
    return resp


SERVER_PUBLIC = "https://u1139344-ba3f-327f7e53.westc.seetacloud.com:8443"


@app.route("/api/favs", methods=["GET", "POST", "OPTIONS"])
def api_favs():
    """收藏：服务器端存储（多端同步）；本地模式转发到服务器"""
    if not ON_SERVER:
        try:
            if request.method == "GET":
                with urllib.request.urlopen(SERVER_PUBLIC + "/api/favs", timeout=30) as r:
                    return r.read()
            data = request.get_json(force=True)
            req = urllib.request.Request(SERVER_PUBLIC + "/api/favs",
                                         json.dumps(data).encode(),
                                         {"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)})
    if request.method == "GET":
        return jsonify({"ok": True, "favs": load_favs()})
    data = request.get_json(force=True)
    favs = data.get("favs", [])
    save_favs(favs)
    return jsonify({"ok": True, "count": len(favs)})


NEG_ENHANCE = [
    "(text:1.5)", "(watermark:1.5)", "(signature:1.5)", "(logo:1.5)",
    "(letter:1.4)", "(caption:1.4)", "(subtitles:1.4)", "(ui:1.4)",
    "(border:1.4)", "(frame:1.4)", "(speech bubble:1.4)", "(dialogue:1.4)",
    "(sound effect:1.4)", "(sfx:1.4)", "(japanese text:1.4)", "(english text:1.4)",
    "(typography:1.4)", "(kana:1.4)", "(kanji:1.4)", "(katakana:1.4)", "(hiragana:1.4)",
    "(words:1.3)", "(writing:1.3)", "(font:1.3)", "(label:1.3)", "(slogan:1.3)",
    "(title:1.3)", "(header:1.3)", "(footer:1.3)", "(menu:1.3)", "(icons:1.3)",
    "(number:1.3)", "(timestamp:1.3)", "(date:1.3)", "(url:1.3)", "(email:1.3)",
    "(barcode:1.3)", "(qr code:1.3)",
]


BRACKET_PAT = re.compile(r"\(+[^()]*?\)+")


def convert_weight_brackets(text):
    """把 (((tag))) 括号圈数转换为 ComfyUI 权重语法 (tag:1.05^n)。
    正面词：圈数越多权重越高；负面词同样（负面里权重高 = 更强抑制）。
    已带 : 权重语法的括号组跳过。倍率用 1.05 而非 1.1：
    角色 tag 权重过高（1.331）会拉爆色彩饱和度和画面密度（实测教训）。"""
    if not text:
        return text

    def repl(m):
        s = m.group(0)
        inner = s.strip("()")
        if not inner or ":" in inner:
            return s
        n = min(len(s) - len(s.lstrip("(")), len(s) - len(s.rstrip(")")))
        w = round(1.05 ** n, 3)
        return "(%s:%.3f)" % (inner.strip(), w)

    return BRACKET_PAT.sub(repl, text)


TAGS_CACHE = None
TAGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tags.csv")


def load_tags():
    global TAGS_CACHE
    if TAGS_CACHE is not None:
        return TAGS_CACHE
    tags = []
    if os.path.exists(TAGS_PATH):
        import csv as _csv
        with open(TAGS_PATH, encoding="utf-8") as f:
            rd = _csv.reader(f)
            next(rd, None)
            for row in rd:
                if len(row) >= 2 and row[1].strip():
                    tags.append(row[1].strip())
    TAGS_CACHE = tags
    return tags


@app.route("/api/tag_suggest")
def api_tag_suggest():
    q = request.args.get("q", "").strip().lower()
    tags = load_tags()
    if not q:
        return jsonify({"ok": True, "items": []})
    pref = [t for t in tags if t.lower().startswith(q)][:12]
    sub = [t for t in tags if q in t.lower() and t not in pref][:12]
    return jsonify({"ok": True, "items": pref + sub})


def enhance_negative(neg: str) -> str:
    """加强负面词：保留用户输入，追加带权重的文字/水印屏蔽词库（已在负面词中的项不重复追加）。"""
    parts = [neg.strip()] if neg and neg.strip() else []
    for item in NEG_ENHANCE:
        tag = item.split(":")[0].lstrip("(")
        if tag not in neg:
            parts.append(item)
    return ", ".join(parts)


def build_upscale_workflow(p):
    """对已生成图片二次采样：LoadImage → 像素放大 → VAEEncode → KSampler(低denoise) → 输出"""
    base = p.get("base", {})
    ckpt = base.get("checkpoint", "waiIllustriousSDXL_v170.safetensors")
    loras = base.get("loras", [])
    steps = int(p.get("steps", base.get("steps", 25)))
    cfg = float(p.get("cfg", base.get("cfg", 7)))
    sampler = p.get("sampler", base.get("sampler", "euler"))
    scheduler = p.get("scheduler", base.get("scheduler", "normal"))
    denoise = float(p.get("denoise", 0.4))
    scale = float(p.get("scale", 1.5))
    seed = int(p.get("seed", -1))
    if seed < 0:
        seed = random.randint(0, 2**31)
    w = int(base.get("width", 1024) * scale // 8 * 8)
    h = int(base.get("height", 1536) * scale // 8 * 8)

    nodes = {
        "src": {"class_type": "LoadImage", "inputs": {"image": p.get("src_image", "upscale_src.png")}},
        "scale": {"class_type": "ImageScale",
                  "inputs": {"image": ["src", 0], "upscale_method": "bicubic",
                             "width": w, "height": h, "crop": "disabled"}},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
    }
    cur_model, cur_clip = ["4", 0], ["4", 1]
    for i, l in enumerate(loras):
        nid = f"5_{i}"
        nodes[nid] = {"class_type": "LoraLoader",
                      "inputs": {"model": cur_model, "clip": cur_clip,
                                 "lora_name": l["name"],
                                 "strength_model": float(l.get("weight", 0.8)),
                                 "strength_clip": float(l.get("weight", 0.8))}}
        cur_model, cur_clip = [nid, 0], [nid, 1]
    nodes["6"] = {"class_type": "CLIPTextEncode",
                  "inputs": {"clip": cur_clip, "text": base.get("prompt", "")}}
    nodes["7"] = {"class_type": "CLIPTextEncode",
                  "inputs": {"clip": cur_clip, "text": enhance_negative(base.get("negative", ""))}}
    nodes["enc"] = {"class_type": "VAEEncode",
                     "inputs": {"pixels": ["scale", 0], "vae": ["4", 2]}}
    nodes["ks"] = {"class_type": "KSampler",
                    "inputs": {"model": cur_model, "positive": ["6", 0], "negative": ["7", 0],
                               "latent_image": ["enc", 0], "seed": seed, "steps": steps,
                               "cfg": cfg, "sampler_name": sampler,
                               "scheduler": scheduler, "denoise": denoise}}
    nodes["8"] = {"class_type": "VAEDecode", "inputs": {"samples": ["ks", 0], "vae": ["4", 2]}}
    nodes["9"] = {"class_type": "SaveImage",
                  "inputs": {"images": ["8", 0], "filename_prefix": "up"}}
    return nodes


def task_worker():
    while True:
        with COND:
            while not TASK_ORDER:
                COND.wait()
            tid = TASK_ORDER[0]
        with TASK_LOCK:
            if tid not in TASK_ORDER:
                continue  # 排队中被取消移除
            TASKS[tid]["status"] = "running"
            TASKS[tid]["stage"] = "preparing"
            TASKS[tid]["progress"] = 0
            TASKS[tid].pop("cancelled", None)
            payload = TASKS[tid]["payload"]
        cancelled = False
        try:
            print(f"[worker] {tid} picked mode={payload.get('mode','gen')}", flush=True)
            if payload.get("mode") == "upscale":
                # 复制源图到 input 目录（供 LoadImage 使用）
                src = payload.get("src_image", "upscale_src.png")
                if ON_SERVER:
                    import shutil
                    out_f = os.path.join(SERVER_BASE, "output", src)
                    in_f = os.path.join(SERVER_BASE, "input", src)
                    if os.path.exists(out_f):
                        shutil.copy(out_f, in_f)
                wf = build_upscale_workflow(payload)
            else:
                print(f"[worker] {tid} building workflow", flush=True)
                wf = build_workflow(payload)
            print(f"[worker] {tid} posting to comfy", flush=True)
            resp = comfy_post("/prompt", {"prompt": wf})
            pid = resp["prompt_id"]
            with TASK_LOCK:
                TASKS[tid]["comfy_pid"] = pid
            print(f"[worker] {tid} submitted {pid} {payload.get('mode','gen')}", flush=True)
            h = {}
            miss_cnt = 0
            # 轮询 ComfyUI 完成（进度由 ws_progress_loop 更新）
            for _ in range(900):
                time.sleep(1)
                with TASK_LOCK:
                    if TASKS[tid].get("cancelled"):
                        cancelled = True
                        break
                try:
                    h = comfy_get(f"/history/{pid}")
                    if pid in h:
                        break
                    miss_cnt += 1
                except Exception:
                    miss_cnt += 1
                    h = {}
                    continue
                # 卡死自愈：history 长时间没有且队列里也没有 → 任务丢失
                if miss_cnt % 10 == 0:
                    try:
                        q = comfy_get("/queue")
                        qids = [x[1] for x in q.get("queue_running", [])] + [x[1] for x in q.get("queue_pending", [])]
                    except Exception:
                        qids = []
                    if pid not in qids:
                        print(f"[worker] {tid} lost (history miss x{miss_cnt}, not in comfy queue)", flush=True)
                        raise RuntimeError("任务在 ComfyUI 侧丢失（不在队列也不在历史）")
            if not cancelled:
                imgs = []
                for out in h.get(pid, {}).get("outputs", {}).values():
                    for img in out.get("images", []):
                        imgs.append({"filename": img["filename"],
                                     "subfolder": img.get("subfolder", ""),
                                     "type": img["type"]})
                with TASK_LOCK:
                    TASKS[tid]["images"] = imgs
                    TASKS[tid]["status"] = "done"
                    TASKS[tid]["stage"] = "done"
                    TASKS[tid]["progress"] = 1.0
                    seed_node = wf.get("10", wf.get("ks"))
                    if seed_node:
                        TASKS[tid]["seed"] = seed_node["inputs"]["seed"]
        except Exception as e:
            with TASK_LOCK:
                TASKS[tid]["status"] = "error"
                TASKS[tid]["error"] = str(e)
            save_tasks()
        if cancelled:
            with TASK_LOCK:
                TASKS[tid]["status"] = "cancelled"
                TASKS[tid]["stage"] = "cancelled"
                TASKS[tid].pop("cancelled", None)
        with COND:
            if TASK_ORDER and TASK_ORDER[0] == tid:
                TASK_ORDER.pop(0)
            COND.notify_all()
        save_tasks()


def ws_progress_loop():
    """监听 ComfyUI WebSocket progress 消息（新版 ComfyUI 无 /progress 接口），
    按 comfy_pid 匹配更新任务进度。断线自动重连。"""
    if websocket is None:
        print("[ws] websocket-client not available", flush=True)
        return

    def on_message(ws, message):
        try:
            msg = json.loads(message)
        except Exception:
            return
        if not isinstance(msg, dict) or msg.get("type") != "progress":
            return
        data = msg.get("data", {}) or {}
        pid = data.get("prompt_id", "")
        maxv = data.get("max", 0) or 0
        if not pid or maxv <= 0:
            return
        pv = (data.get("value", 0) or 0) / maxv
        with TASK_LOCK:
            for t in TASKS.values():
                if t.get("comfy_pid") == pid and t.get("status") == "running":
                    t["progress"] = round(pv, 3)
                    t["stage"] = "sampling" if pv > 0 else "preparing"

    while True:
        try:
            print("[ws] connecting...", flush=True)
            ws = websocket.WebSocketApp("ws://127.0.0.1:8188/ws?clientId=genui_progress",
                                        on_message=on_message)
            ws.run_forever(ping_interval=20, ping_timeout=10)
            print("[ws] disconnected, reconnect in 3s", flush=True)
        except Exception as e:
            print("[ws] error:", type(e).__name__, str(e)[:150], flush=True)
        time.sleep(3)


def clear_comfy_queue():
    """启动时清掉 ComfyUI 残留任务（旧进程提交的），避免新任务排队等幽灵任务"""
    try:
        comfy_post("/interrupt", {})
    except Exception:
        pass
    try:
        req = urllib.request.Request(COMFY + "/queue", b"{}",
                                     {"Content-Type": "application/json"}, method="DELETE")
        with urllib.request.urlopen(req, timeout=10) as r:
            r.read()
    except Exception:
        pass


def comfy_get(path):
    with urllib.request.urlopen(COMFY + path, timeout=30) as r:
        return json.loads(r.read())


def comfy_post(path, data):
    req = urllib.request.Request(COMFY + path, json.dumps(data).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


@app.route("/")
def index():
    return render_template("index.html")


def _obj_names(class_type, key):
    try:
        info = comfy_get(f"/object_info/{class_type}")
        return [n for n in info[class_type]["input"]["required"][key][0]]
    except Exception:
        return []


@app.route("/api/checkpoints")
def api_checkpoints():
    items = _obj_names("CheckpointLoaderSimple", "ckpt_name")
    # waiIllustriousSDXL_v170 固定排第一（页面默认模型）
    items.sort(key=lambda n: (n != "waiIllustriousSDXL_v170.safetensors", n))
    return jsonify({"ok": True, "items": items})


@app.route("/api/loras")
def api_loras():
    return jsonify({"ok": True, "items": _obj_names("LoraLoader", "lora_name")})


@app.route("/api/vaes")
def api_vaes():
    items = _obj_names("VAELoader", "vae_name")
    return jsonify({"ok": True, "items": ["内置 (checkpoint)"] + items})


@app.route("/api/controlnets")
def api_controlnets():
    return jsonify({"ok": True, "items": _obj_names("ControlNetLoader", "control_net_name")})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    """上传参考图到 ComfyUI input 目录"""
    f = request.files.get("file")
    if not f:
        return jsonify({"ok": False, "error": "no file"})
    fname = secure_filename(f.filename)
    data = f.read()
    boundary = "----genui" + str(random.randint(10**9, 10**10))
    body = (f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="image"; filename="{fname}"\r\n'
            f"Content-Type: image/png\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(COMFY + "/upload/image", body,
                                 {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read())
        return jsonify({"ok": True, "name": resp.get("name", fname)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


def invert_mask_alpha(mask_name):
    """前端 mask 白笔刷 alpha=255 表示重绘区；ComfyUI LoadImage 的 MASK=1-alpha（1=重绘）。
    统一反转 alpha：重绘区 alpha=0，保留区 alpha=255。"""
    import cv2
    input_dir = "/root/autodl-tmp/ComfyUI/input" if ON_SERVER else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "ComfyUI", "input")
    mask_path = os.path.join(input_dir, mask_name)
    mask = cv2.imread(mask_path, cv2.IMREAD_UNCHANGED)
    if mask is None:
        return
    if mask.shape[2] == 4:
        mask[:, :, 3] = 255 - mask[:, :, 3]
    else:
        mask = cv2.cvtColor(mask, cv2.COLOR_BGR2BGRA)
        mask[:, :, 3] = 0  # 无 alpha 的 mask 视为全图重绘
    cv2.imwrite(mask_path, mask)


def auto_mask(src_name, mode="body"):
    """生成自动遮罩（前端风格：白色 alpha 255 = 重绘区，透明 = 保留区）。
    mode='body'：最低人脸下沿以下的整幅区域（一键去衣，配合姿势/肤色锁保持身体结构）
    mode='all_but_face'：除人脸外全部重绘（保留脸部独立功能，无需手动涂抹选区）
    返回 (mask文件名, 检测到的人脸数)。"""
    import cv2
    import numpy as np
    input_dir = "/root/autodl-tmp/ComfyUI/input" if ON_SERVER else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "ComfyUI", "input")
    src_path = os.path.join(input_dir, src_name)
    if not os.path.exists(src_path):
        return None, 0
    src = cv2.imread(src_path)
    if src is None:
        return None, 0
    H, W = src.shape[:2]
    gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    faces = cascade.detectMultiScale(gray, 1.1, 5,
                                     minSize=(int(min(H, W) * 0.06), int(min(H, W) * 0.06)))
    mask = np.zeros((H, W, 4), dtype=np.uint8)  # 全透明 = 保留原图
    if len(faces):
        if mode == "body":
            # 脖子线 = 最低可信人脸的下沿（只认中心在上 2/3 的脸，
            # 防 Haar 在身体/背景上的误检把脖子线压到底部）。
            # 无可信人脸时按常见构图取 22% 高作脖子线，脸区交给后端 keep_face 兑底。
            candidates = [y + h for (x, y, w, h) in faces if (y + h / 2) < H * 0.67]
            if candidates:
                neck = max(candidates)
            else:
                neck = int(H * 0.22)
            neck = min(H - 1, neck + int(H * 0.03))
            mask[neck:, :, :] = 255
        else:  # all_but_face：全图重绘，挖掉人脸区（同样只挖可信脸）
            mask[:, :, :] = 255
            for (x, y, w, h) in faces:
                if (y + h / 2) >= H * 0.67:
                    continue
                pad = int(max(w, h) * 0.18)
                x0 = max(0, x - pad); y0 = max(0, y - pad)
                x1 = min(W, x + w + pad); y1 = min(H, y + h + pad)
                mask[y0:y1, x0:x1, :] = 0
    else:
        mask[:, :, :] = 255  # 未检测到人脸：整图重绘（无脸可保）
    fname = "automask_%d.png" % int(time.time())
    out = os.path.join(input_dir, fname)
    cv2.imwrite(out, mask)
    return fname, len(faces)


@app.route("/api/automask", methods=["POST"])
def api_automask():
    """生成自动遮罩（前端风格：白=重绘）。mode: body=身体区(一键去衣) / all_but_face=除脸外全部"""
    data = request.get_json(force=True)
    src = (data.get("src_image") or "").strip()
    mode = data.get("mode", "body")
    if not src:
        return jsonify({"ok": False, "error": "缺少参考图"})
    try:
        fname, nfaces = auto_mask(src, mode)
        if not fname:
            return jsonify({"ok": False, "error": "自动遮罩生成失败"})
        return jsonify({"ok": True, "mask_image": fname, "faces": nfaces})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


def protect_faces(src_name, mask_name):
    """局部重绘：把人脸区域从 mask 中挖掉（alpha 置 255=保留），保持脸部不变。返回保护的脸数。"""
    import cv2
    input_dir = "/root/autodl-tmp/ComfyUI/input" if ON_SERVER else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "ComfyUI", "input")
    src_path = os.path.join(input_dir, src_name)
    mask_path = os.path.join(input_dir, mask_name)
    if not (os.path.exists(src_path) and os.path.exists(mask_path)):
        return 0
    src = cv2.imread(src_path)
    mask = cv2.imread(mask_path, cv2.IMREAD_UNCHANGED)
    if src is None or mask is None:
        return 0
    H, W = src.shape[:2]
    mh, mw = mask.shape[:2]
    gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    faces = cascade.detectMultiScale(gray, 1.1, 5, minSize=(int(min(H, W) * 0.06), int(min(H, W) * 0.06)))
    sx, sy = mw / W, mh / H
    for (x, y, w, h) in faces:
        pad = int(max(w, h) * 0.18)
        x0 = max(0, int((x - pad) * sx)); y0 = max(0, int((y - pad) * sy))
        x1 = min(mw, int((x + w + pad) * sx)); y1 = min(mh, int((y + h + pad) * sy))
        if mask.shape[2] == 4:
            mask[y0:y1, x0:x1, 3] = 255  # 保留区
        else:
            mask[y0:y1, x0:x1] = 255
    cv2.imwrite(mask_path, mask)
    return len(faces)


def build_workflow(p):
    ckpt = p["checkpoint"]
    loras = p.get("loras", [])
    steps = int(p.get("steps", 28))
    cfg = float(p.get("cfg", 7))
    sampler = p.get("sampler", "euler")
    scheduler = p.get("scheduler", "normal")
    width = int(p.get("width", 1024))
    height = int(p.get("height", 1536))
    seed = int(p.get("seed", -1))
    if seed < 0:
        seed = random.randint(0, 2**31)
    batch = int(p.get("batch", 1))
    clip_skip = int(p.get("clip_skip", 1))
    vae_name = p.get("vae", "内置 (checkpoint)")
    hires = p.get("hires", False)
    hires_scale = float(p.get("hires_scale", 1.5))
    hires_denoise = float(p.get("hires_denoise", 0.4))
    cn = p.get("controlnet")  # {enabled, image, model, strength} or None
    src_image = p.get("src_image")
    denoise = float(p.get("denoise", 0.5))

    nodes = {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
    }
    cur_model, cur_clip = ["4", 0], ["4", 1]

    # LoRA 链
    for i, l in enumerate(loras):
        nid = f"5_{i}"
        nodes[nid] = {"class_type": "LoraLoader",
                      "inputs": {"model": cur_model, "clip": cur_clip,
                                 "lora_name": l["name"],
                                 "strength_model": float(l.get("weight", 0.8)),
                                 "strength_clip": float(l.get("weight", 0.8))}}
        cur_model, cur_clip = [nid, 0], [nid, 1]

    # CLIP skip
    if clip_skip > 1:
        nodes["cs"] = {"class_type": "CLIPSetLastLayer",
                       "inputs": {"clip": cur_clip, "stop_at_clip_layer": -clip_skip}}
        cur_clip = ["cs", 0]

    # VAE
    vae_ref = ["4", 2]
    if vae_name != "内置 (checkpoint)":
        nodes["vae"] = {"class_type": "VAELoader", "inputs": {"vae_name": vae_name}}
        vae_ref = ["vae", 0]

    pos = {"class_type": "CLIPTextEncode", "inputs": {"clip": cur_clip, "text": p["prompt"]}}
    neg = {"class_type": "CLIPTextEncode", "inputs": {"clip": cur_clip, "text": enhance_negative(p.get("negative", ""))}}
    nodes["6"], nodes["7"] = pos, neg

    # ControlNet
    pos_ref, neg_ref = ["6", 0], ["7", 0]
    if cn and cn.get("enabled") and cn.get("image"):
        nodes["cn_img"] = {"class_type": "LoadImage", "inputs": {"image": cn["image"]}}
        nodes["cn_net"] = {"class_type": "ControlNetLoader",
                           "inputs": {"control_net_name": cn.get("model", "")}}
        nodes["cn_apply"] = {"class_type": "ControlNetApplyAdvanced",
                             "inputs": {"positive": pos_ref, "negative": neg_ref,
                                        "control_net": ["cn_net", 0], "image": ["cn_img", 0],
                                        "strength": float(cn.get("strength", 0.8)),
                                        "start_percent": 0.0, "end_percent": 1.0}}
        pos_ref, neg_ref = ["cn_apply", 0], ["cn_apply", 1]

    nodes["3"] = {"class_type": "EmptyLatentImage",
                  "inputs": {"width": width, "height": height, "batch_size": batch}}
    latent_ref, ks_denoise = ["3", 0], 1.0
    inpaint = p.get("inpaint") if isinstance(p.get("inpaint"), dict) else None
    if inpaint and inpaint.get("mask_image") and src_image:
        # 局部重绘：mask 内重绘，mask 外保持原图（脸已被 protect_faces 挖掉）
        nodes["src"] = {"class_type": "LoadImage", "inputs": {"image": src_image}}
        nodes["mask_im"] = {"class_type": "LoadImage", "inputs": {"image": inpaint["mask_image"]}}
        # LoadImage 输出 [1] = MASK（alpha 通道），直接用，无需 ImageToMask
        nodes["enc_i"] = {"class_type": "VAEEncodeForInpaint",
                          "inputs": {"pixels": ["src", 0], "vae": vae_ref,
                                     "mask": ["mask_im", 1], "grow_mask_by": 14}}
        latent_ref, ks_denoise = ["enc_i", 0], 1.0
        inpaint_active = True
        # 姿势锁定：DW 骨架 → OpenPose ControlNet（防止重绘改变姿势/身体结构）
        if inpaint.get("pose_lock", True):
            nodes["dw"] = {"class_type": "DWPreprocessor",
                           "inputs": {"image": ["src", 0],
                                      "pose_estimator": "dw-ll_ucoco_384.onnx",
                                      "bbox_detector": "yolox_l.onnx"}}
            nodes["cn_pose"] = {"class_type": "ControlNetLoader",
                                "inputs": {"control_net_name": "xinsir-controlnet-openpose-sdxl-1.0.safetensors"}}
            nodes["cn_apply_pose"] = {"class_type": "ControlNetApplyAdvanced",
                                      "inputs": {"positive": pos_ref, "negative": neg_ref,
                                                 "control_net": ["cn_pose", 0], "image": ["dw", 0],
                                                 "strength": 0.85, "start_percent": 0.0, "end_percent": 1.0}}
            pos_ref, neg_ref = ["cn_apply_pose", 0], ["cn_apply_pose", 1]
        # 肤色保持：IPAdapter style transfer（原图作参考，迁移肤色/质感）
        if inpaint.get("skin_keep", True):
            nodes["ip_loader"] = {"class_type": "IPAdapterUnifiedLoader",
                                  "inputs": {"model": cur_model, "preset": "PLUS (high strength)"}}
            nodes["ip_adv"] = {"class_type": "IPAdapterAdvanced",
                               "inputs": {"model": ["ip_loader", 0], "ipadapter": ["ip_loader", 1],
                                          "image": ["src", 0], "weight": 0.5,
                                          "weight_type": "linear",
                                          "combine_embeds": "concat",
                                          "start_at": 0.0, "end_at": 1.0,
                                          "embeds_scaling": "V only"}}
            cur_model = ["ip_adv", 0]
    elif src_image:
        # img2img：参考图编码为 latent，用 denoise 控制重绘幅度
        nodes["src"] = {"class_type": "LoadImage", "inputs": {"image": src_image}}
        nodes["enc"] = {"class_type": "VAEEncode",
                         "inputs": {"pixels": ["src", 0], "vae": vae_ref}}
        latent_ref, ks_denoise = ["enc", 0], denoise
        inpaint_active = False
    else:
        inpaint_active = False
    nodes["10"] = {"class_type": "KSampler",
                   "inputs": {"model": cur_model, "positive": pos_ref, "negative": neg_ref,
                              "latent_image": latent_ref, "seed": seed, "steps": steps, "cfg": cfg,
                              "sampler_name": sampler, "scheduler": scheduler, "denoise": ks_denoise}}

    # Hires fix：潜空间放大 + 二次采样
    samp_ref = ["10", 0]
    if hires:
        hw = int(width * hires_scale // 8 * 8)
        hh = int(height * hires_scale // 8 * 8)
        nodes["11"] = {"class_type": "LatentUpscale",
                       "inputs": {"samples": samp_ref, "upscale_method": "nearest-exact",
                                  "width": hw, "height": hh, "crop": "disabled"}}
        nodes["12"] = {"class_type": "KSampler",
                       "inputs": {"model": cur_model, "positive": pos_ref, "negative": neg_ref,
                                  "latent_image": ["11", 0], "seed": seed + 1,
                                  "steps": int(steps * 0.8), "cfg": cfg,
                                  "sampler_name": sampler, "scheduler": scheduler,
                                  "denoise": hires_denoise}}
        samp_ref = ["12", 0]

    nodes["8"] = {"class_type": "VAEDecode", "inputs": {"samples": samp_ref, "vae": vae_ref}}
    prefix = p.get("prefix", "gen")
    if inpaint_active:
        # 重绘结果贴回原图（mask 外保持原图像素）
        nodes["8b"] = {"class_type": "ImageCompositeMasked",
                       "inputs": {"destination": ["src", 0], "source": ["8", 0],
                                  "x": 0, "y": 0, "resize_source": False,
                                  "mask": ["mask_im", 1]}}
        nodes["9"] = {"class_type": "SaveImage",
                      "inputs": {"images": ["8b", 0], "filename_prefix": prefix}}
    else:
        nodes["9"] = {"class_type": "SaveImage",
                      "inputs": {"images": ["8", 0], "filename_prefix": prefix}}
    return nodes


@app.route("/api/generate", methods=["POST"])
def api_generate():
    """入队生成，立即返回 task_id"""
    p = request.get_json(force=True)
    inp = p.get("inpaint") if isinstance(p.get("inpaint"), dict) else None
    if inp and inp.get("mask_image"):
        try:
            invert_mask_alpha(inp["mask_image"])
            # 自动遮罩生成时已按可信脸位置挖好脸区，跳过 protect_faces（
            # 避免 Haar 在身体/背景上的误检把衣服区域当脸保留，导致畸形）
            if inp.get("keep_face", True) and not inp.get("auto_mask"):
                n = protect_faces(p.get("src_image", ""), inp["mask_image"])
                print(f"[inpaint] 脸部保护: {n} 张脸", flush=True)
        except Exception as e:
            print(f"[inpaint] mask 处理失败: {e}", flush=True)
    tid = uuid.uuid4().hex[:12]
    p = {**p, "prefix": f"gen_{tid}"}
    with TASK_LOCK:
        TASKS[tid] = {"status": "queued", "payload": p, "images": [],
                      "error": None, "created": time.time(),
                      "progress": 0, "stage": "queued"}
    with COND:
        TASK_ORDER.append(tid)
        COND.notify_all()
    save_tasks()
    return jsonify({"ok": True, "task_id": tid})


@app.route("/api/upscale", methods=["POST"])
def api_upscale():
    """对已生成图片二次采样（Hires Fix 后处理）：入队"""
    data = request.get_json(force=True)
    fn = data.get("filename", "")
    if not fn or ".." in fn or "/" in fn:
        return jsonify({"ok": False, "error": "非法文件名"})
    # 找该图所属任务的 payload 作为基础设置
    base = None
    with TASK_LOCK:
        for t in TASKS.values():
            for im in t.get("images", []):
                if im.get("filename") == fn:
                    base = dict(t["payload"])
                    break
            if base:
                break
    if base is None:
        base = {"checkpoint": "waiIllustriousSDXL_v170.safetensors",
                "loras": [], "prompt": "", "negative": "",
                "steps": 25, "cfg": 7, "sampler": "euler", "scheduler": "normal",
                "width": 1024, "height": 1536}
    base.pop("mode", None)
    payload = {"mode": "upscale", "src_image": fn,
               "base": base,
               "scale": float(data.get("scale", 1.5)),
               "denoise": float(data.get("denoise", 0.4)),
               "steps": int(data.get("steps", 25)),
               "cfg": float(data.get("cfg", 7)),
               "sampler": data.get("sampler", "euler"),
               "scheduler": data.get("scheduler", "normal"),
               "seed": int(data.get("seed", -1)),
               "prefix": "up"}
    tid = uuid.uuid4().hex[:12]
    with TASK_LOCK:
        TASKS[tid] = {"status": "queued", "payload": payload, "images": [],
                      "error": None, "created": time.time(),
                      "progress": 0, "stage": "queued"}
    with COND:
        TASK_ORDER.append(tid)
        COND.notify_all()
    save_tasks()
    return jsonify({"ok": True, "task_id": tid})


@app.route("/api/tasks")
def api_tasks():
    with TASK_LOCK:
        items = [{"id": tid, "status": t["status"], "images": t["images"],
                  "error": t["error"], "created": t["created"],
                  "progress": t.get("progress", 0), "stage": t.get("stage", ""),
                  "eta": t.get("eta"),
                  "prompt": t["payload"].get("prompt", "")[:80],
                  "payload": t["payload"]}
                 for tid, t in TASKS.items()]
    items.sort(key=lambda x: x["created"], reverse=True)
    return jsonify({"ok": True, "tasks": items[:50]})


@app.route("/api/instance", methods=["POST"])
def api_instance():
    """保存新实例 SSH/公网信息；服务器直跑模式顺手后台执行恢复脚本（自助复位，无需本地网关）"""
    data = request.get_json(force=True)
    text = (data.get("text") or "").strip()
    m = re.match(r"ssh\s+-p\s+(\d+)\s+(\S+@\S+)\s+(\S+)\s+(https?://\S+)", text)
    if not m:
        return jsonify({"ok": False,
                        "error": "格式无法解析，示例：ssh -p 25562 root@connect.westc.seetacloud.com 密码 https://公网:8443"})
    port, host, pwd, url = m.groups()
    info = {"ssh_port": port, "ssh_host": host, "ssh_password": pwd,
            "public_url": url, "updated": time.strftime("%Y-%m-%d %H:%M:%S")}
    try:
        with open("/root/autodl-tmp/instance.json", "w", encoding="utf-8") as f:
            json.dump(info, f, ensure_ascii=False, indent=1)
    except Exception as e:
        return jsonify({"ok": False, "error": "保存失败: %s" % e})
    restored = False
    if ON_SERVER and os.path.exists("/root/autodl-tmp/restore_after_boot.sh"):
        # 后台异步恢复（脚本会 pkill 当前 genui，不能在请求进程里同步跑）
        try:
            with open("/root/autodl-tmp/restore_auto.log", "w", encoding="utf-8") as f:
                f.write("恢复开始: %s\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
            log_f = open("/root/autodl-tmp/restore_auto.log", "a", encoding="utf-8")
            subprocess.Popen(["bash", "/root/autodl-tmp/restore_after_boot.sh"],
                             stdout=log_f, stderr=subprocess.STDOUT,
                             start_new_session=True)
            restored = True
        except Exception as e:
            print("[instance] 恢复启动失败:", e, flush=True)
    return jsonify({"ok": True, "restored": restored,
                    "instance": {"ssh_port": port, "ssh_host": host, "public_url": url},
                    "note": ("已保存，后台恢复服务中（约 1-2 分钟），恢复期间页面会断一下，完成后自动回来"
                             if restored else
                             "已保存。固定入口与本地网关由本地复位脚本同步（scripts/reset_instance.py）")})


@app.route("/api/instance/status")
def api_instance_status():
    """自助复位进度：instance.json + 恢复日志尾部 + 服务存活状态"""
    info = {}
    try:
        with open("/root/autodl-tmp/instance.json", encoding="utf-8") as f:
            info = json.load(f)
    except Exception:
        pass
    log = ""
    try:
        with open("/root/autodl-tmp/restore_auto.log", encoding="utf-8") as f:
            log = f.read()[-4000:]
    except Exception:
        pass
    alive = False
    if ON_SERVER:
        try:
            comfy_get("/system_stats")
            alive = True
        except Exception:
            alive = False
    return jsonify({"ok": True, "instance": info, "log": log, "alive": alive})


@app.route("/api/cancel", methods=["POST"])
def api_cancel():
    """取消任务：排队中直接移除；生成中标记取消并打断 ComfyUI 当前采样"""
    data = request.get_json(force=True)
    tid = data.get("task_id", "")
    with TASK_LOCK:
        t = TASKS.get(tid)
        if not t:
            return jsonify({"ok": False, "error": "任务不存在"})
        if t["status"] == "queued":
            if tid in TASK_ORDER:
                TASK_ORDER.remove(tid)
            t["status"] = "cancelled"
            t["stage"] = "cancelled"
            with COND:
                COND.notify_all()
            save_tasks()
            return jsonify({"ok": True, "status": "cancelled"})
        if t["status"] == "running":
            t["cancelled"] = True
            try:
                comfy_post("/interrupt", {})
            except Exception:
                pass
            return jsonify({"ok": True, "status": "cancelling"})
        return jsonify({"ok": False, "error": "任务 %s 状态不可取消" % t["status"]})


@app.route("/api/status/<pid>")
def api_status(pid):
    try:
        h = comfy_get(f"/history/{pid}")
        if pid not in h:
            return jsonify({"ok": True, "done": False})
        imgs = []
        for out in h[pid].get("outputs", {}).values():
            for img in out.get("images", []):
                imgs.append({"filename": img["filename"], "subfolder": img.get("subfolder", ""),
                             "type": img["type"]})
        return jsonify({"ok": True, "done": True, "images": imgs})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/image")
def api_image():
    fn = request.args.get("filename", "")
    sub = request.args.get("subfolder", "")
    typ = request.args.get("type", "output")
    if not fn or ".." in fn or "/" in fn or "\\" in fn:
        return jsonify({"ok": False, "error": "非法文件名"})
    if sub and (".." in sub or "/" in sub or "\\" in sub):
        return jsonify({"ok": False, "error": "非法路径"})
    try:
        if ON_SERVER:
            # 直接读本地文件：快 + 支持 304/缓存头（图片名唯一，长缓存安全）
            base = SERVER_BASE
            if typ == "input":
                base = os.path.join(base, "input")
            elif typ == "temp":
                base = os.path.join(base, "temp")
            else:
                base = os.path.join(base, "output")
            p = os.path.join(base, sub, fn)
            if not os.path.exists(p):
                return jsonify({"ok": False, "error": "文件不存在"}), 404
            return send_file(p, mimetype="image/png", conditional=True, max_age=31536000)
        with urllib.request.urlopen(f"{COMFY}/view?filename={fn}&subfolder={sub}&type={typ}",
                                    timeout=60) as r:
            resp = send_file(BytesIO(r.read()), mimetype="image/png",
                             conditional=True, max_age=31536000)
            return resp
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/thumb")
def api_thumb():
    """画廊缩略图：服务端生成 webp 小图（缓存到 thumbs 目录），画廊卡加载它避免大图卡顿"""
    fn = request.args.get("filename", "")
    sub = request.args.get("subfolder", "")
    typ = request.args.get("type", "output")
    if not fn or ".." in fn or "/" in fn or "\\" in fn:
        return jsonify({"ok": False, "error": "非法文件名"})
    if sub and (".." in sub or "/" in sub or "\\" in sub):
        return jsonify({"ok": False, "error": "非法路径"})
    try:
        if not ON_SERVER:
            # 本地模式直接转发原图
            with urllib.request.urlopen(f"{COMFY}/view?filename={fn}&subfolder={sub}&type={typ}",
                                        timeout=60) as r:
                resp = send_file(BytesIO(r.read()), mimetype="image/png",
                                 conditional=True, max_age=31536000)
                return resp
        base = SERVER_BASE
        if typ == "input":
            base = os.path.join(base, "input")
        elif typ == "temp":
            base = os.path.join(base, "temp")
        else:
            base = os.path.join(base, "output")
        p = os.path.join(base, sub, fn)
        if not os.path.exists(p):
            return jsonify({"ok": False, "error": "文件不存在"}), 404
        cache_dir = os.path.join(SERVER_BASE, "thumbs")
        cache = os.path.join(cache_dir, fn + ".webp")
        if not os.path.exists(cache) or os.path.getmtime(cache) < os.path.getmtime(p):
            os.makedirs(cache_dir, exist_ok=True)
            from PIL import Image
            im = Image.open(p)
            im.thumbnail((360, 360))
            im.convert("RGB").save(cache, "WEBP", quality=82)
        return send_file(cache, mimetype="image/webp", conditional=True, max_age=31536000)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


def _ssh(args):
    """本地模式经 SSH 执行；服务器模式直接本地执行"""
    if ON_SERVER:
        return subprocess.run(args, capture_output=True, timeout=120)
    cmd = ["ssh", "-i", SSH_KEY, "-p", SSH_PORT, "-o", "StrictHostKeyChecking=accept-new",
           SSH_TARGET] + args
    return subprocess.run(cmd, capture_output=True, timeout=120)


@app.route("/api/delete_image", methods=["POST"])
def api_delete_image():
    """删除服务器 ComfyUI output 中的图片文件，并同步移除任务记录"""
    data = request.get_json(force=True)
    fn = data.get("filename", "")
    if not fn or ".." in fn or "/" in fn or "\\" in fn:
        return jsonify({"ok": False, "error": "非法文件名"})
    if ON_SERVER:
        p = os.path.join(SERVER_BASE, "output", fn)
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)})
        try:
            thumb = os.path.join(SERVER_BASE, "thumbs", fn + ".webp")
            if os.path.exists(thumb):
                os.remove(thumb)
        except Exception:
            pass
    else:
        r = _ssh([f"/root/miniconda3/bin/python -c 'import os; os.remove(\"{SERVER_BASE}/output/{fn}\")'"])
        if r.returncode != 0:
            return jsonify({"ok": False, "error": r.stderr.decode()[:200]})
    # 同步从内存任务记录中移除（防止前端轮询重新渲染）
    with TASK_LOCK:
        for t in TASKS.values():
            t["images"] = [i for i in t.get("images", []) if i.get("filename") != fn]
    save_tasks()
    return jsonify({"ok": True})


@app.route("/api/import", methods=["POST"])
def api_import():
    """导入 safetensors：收文件 → scp 到服务器对应目录"""
    f = request.files.get("file")
    kind = request.form.get("kind", "lora")
    if not f:
        return jsonify({"ok": False, "error": "no file"})
    fname = secure_filename(f.filename)
    if not fname.endswith(".safetensors"):
        return jsonify({"ok": False, "error": "只支持 .safetensors"})
    dest_dir = "checkpoints" if kind == "checkpoint" else "loras"
    local_tmp = os.path.join("upload_tmp", fname)
    os.makedirs("upload_tmp", exist_ok=True)
    total = 0
    with open(local_tmp, "wb") as out:
        while True:
            chunk = f.read(4 * 1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            total += len(chunk)
    if ON_SERVER:
        dest = os.path.join(SERVER_BASE, dest_dir, fname)
        try:
            os.replace(local_tmp, dest)
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)})
        return jsonify({"ok": True, "name": fname, "size_mb": round(total / 1e6, 1),
                        "dest": dest_dir})
    dest = f"/root/autodl-tmp/ComfyUI/models/{dest_dir}/{fname}"
    key = os.path.expanduser(r"~/.ssh/id_ed25519")
    cmd = ["scp", "-P", SSH_PORT, "-i", key, "-o", "StrictHostKeyChecking=accept-new",
           local_tmp, f"{SSH_TARGET}:{dest}"]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=7200)
        if r.returncode != 0:
            return jsonify({"ok": False, "error": r.stderr.decode()[:300]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})
    finally:
        try:
            os.remove(local_tmp)
        except Exception:
            pass
    return jsonify({"ok": True, "name": fname, "size_mb": round(total / 1e6, 1),
                    "dest": dest_dir})


@app.route("/api/triggers")
def api_triggers():
    """读取服务器模型 metadata 中的触发词（缓存 120s）"""
    now = time.time()
    if TRIGGER_CACHE["data"] and now - TRIGGER_CACHE["ts"] < 120:
        return jsonify({"ok": True, **TRIGGER_CACHE["data"]})
    if ON_SERVER:
        r = subprocess.run(["/root/miniconda3/bin/python", "/root/autodl-tmp/read_triggers.py"],
                           capture_output=True, timeout=120)
    else:
        r = _ssh(["/root/miniconda3/bin/python /root/autodl-tmp/read_triggers.py"])
    try:
        if r.returncode != 0:
            return jsonify({"ok": False, "error": r.stderr.decode()[:200]})
        data = json.loads(r.stdout.decode())
        TRIGGER_CACHE.update({"data": data, "ts": now})
        return jsonify({"ok": True, **data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


if __name__ == "__main__":
    # 所有定义就绪后再启动线程/恢复队列（避免模块加载期间 worker 引用未定义名字）
    threading.Thread(target=task_worker, daemon=True).start()
    threading.Thread(target=ws_progress_loop, daemon=True).start()
    load_tasks()
    clear_comfy_queue()
    port = int(os.environ.get("GENUI_PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=False)
