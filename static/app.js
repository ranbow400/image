const $ = (id) => document.getElementById(id);
const LS_KEY = "***";
const LS_FAV = "genui_favs_v1";

const CONTROLS = ["ckpt", "vae", "prompt", "negative", "steps", "cfg", "sampler", "scheduler",
                  "width", "height", "seed", "batch", "clipSkip", "enhCompat",
                  "biasMode", "biasStrength"];

async function api(path, opts) {
  const r = await fetch(path, opts);
  return r.json();
}

// ---------- 设置持久化 ----------
function saveSettings() {
  const s = {};
  for (const id of CONTROLS) {
    const el = $(id);
    if (!el) continue;
    s[id] = el.type === "checkbox" ? el.checked : el.value;
  }
  s.loras = [...document.querySelectorAll(".lora-row")].map(r => ({
    name: r.querySelector("select").value,
    weight: r.querySelector("input").value,
  }));
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) {}
  for (const id of CONTROLS) {
    const el = $(id);
    if (!el || !(id in s)) continue;
    if (el.type === "checkbox") el.checked = !!s[id];
    else el.value = s[id];
  }
  window.PENDING_LORAS = s.loras || [];
}

CONTROLS.forEach(id => {
  const el = $(id);
  if (el) el.addEventListener("change", saveSettings);
});
document.querySelectorAll("textarea, input").forEach(el => {
  if (!el.id) return;
  el.addEventListener("input", saveSettings);
});

// ---------- 收藏（服务器端存储） ----------
let FAVS_CACHE = [];

async function loadFavs() {
  try {
    const r = await api("/api/favs");
    if (r.ok) {
      FAVS_CACHE = r.favs || [];
      // 迁移：本地旧数据合并上传（仅旧页面 origin 有）
      let old = [];
      try { old = JSON.parse(localStorage.getItem(LS_FAV)) || []; } catch (e) {}
      if (old.length) {
        const merged = [...old, ...FAVS_CACHE];
        const seen = new Set();
        const uniq = merged.filter(f => { const k = f.img && f.img.filename; if (!k || seen.has(k)) return false; seen.add(k); return true; });
        FAVS_CACHE = uniq;
        await saveFavs();
        localStorage.removeItem(LS_FAV);
        console.log("收藏已迁移到服务器:", uniq.length);
      }
      updateFavCount();
      renderFavs();
    }
  } catch (e) {}
}

async function saveFavs() {
  try {
    await api("/api/favs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favs: FAVS_CACHE }),
    });
  } catch (e) {}
}

function getFavs() { return FAVS_CACHE; }

function setFavs(f) { FAVS_CACHE = f; saveFavs(); updateFavCount(); }
function updateFavCount() { $("favCount").textContent = FAVS_CACHE.length; }

let REF_IMAGE = "";  // 已上传的 img2img 参考图文件名

function collectSettings() {
  const loras = [...document.querySelectorAll(".lora-row")].map(r => ({
    name: r.querySelector("select").value,
    weight: parseFloat(r.querySelector("input").value),
  })).filter(l => l.name && l.name !== "None");
  return {
    checkpoint: $("ckpt").value, loras, vae: $("vae").value,
    prompt: $("prompt").value, negative: $("negative").value,
    steps: parseInt($("steps").value), cfg: parseFloat($("cfg").value),
    sampler: $("sampler").value, scheduler: $("scheduler").value,
    width: parseInt($("width").value), height: parseInt($("height").value),
    seed: parseInt($("seed").value), batch: parseInt($("batch").value),
    clip_skip: parseInt($("clipSkip").value) || 1,
    src_image: ($("i2iOn").checked && REF_IMAGE) ? REF_IMAGE : "",
    denoise: parseFloat($("denoise").value),
    noise_bias: { mode: $("biasMode").value, strength: parseFloat($("biasStrength").value) || 0 },
  };
}

// ---------- 噪声叠加：打分学出的潜空间偏向（不动参数、不动提示词） ----------
const RATE_LABEL = { 5: "收藏", 4: "优秀", 3: "正常", 2: "有问题", 1: "用不了" };
let biasTimer = null;

function paintBiasVal() {
  const v = parseFloat($("biasStrength").value) || 0;
  $("biasVal").textContent = v.toFixed(2);
  return v;
}

function paintBiasInfo(r) {
  const el = $("biasHint");
  if (!el || !r || !r.ok) return;
  const m = r.meta || {}, f = r.files || {}, p = r.progress || {};
  const ready = f.good && f.diff;
  if (r.running) {
    const total = p.total || 0, done = p.done || 0;
    el.textContent = total
      ? `重建中：已编码 ${done}/${total} 张（好图 ${p.n_good || "?"} / 坏图 ${p.n_bad || "?"}，有缓存的图直接跳过）`
      : "重建中：正在读取打分数据...";
    return;
  }
  const head = ready
    ? `偏向已就绪 · 好图 ${m.n_good} 张 / 坏图 ${m.n_bad} 张（3★ 正常的不参与） · 建于 ${m.built_at || "?"}`
    : "偏向文件还没建，点下面的按钮生成";
  const last = p.built_at && p.built_at !== m.built_at ? ` · 上次重建 ${p.built_at}` : "";
  el.textContent = head + last;
}

async function loadBiasInfo() {
  paintBiasVal();
  try {
    const r = await api("/api/noise_bias");
    paintBiasInfo(r);
    if (r.running && !biasTimer) {
      biasTimer = setInterval(async () => {
        const rr = await api("/api/noise_bias");
        paintBiasInfo(rr);
        if (!rr.running) { clearInterval(biasTimer); biasTimer = null; loadBiasInfo(); }
      }, 4000);
    }
  } catch (e) {}
}

$("biasStrength").oninput = () => { paintBiasVal(); saveSettings(); };
$("biasMode").onchange = () => { saveSettings(); };
$("biasRebuild").onclick = async () => {
  if (!confirm("用当前打分重建偏向？有缓存的图直接复用，只编码新增的图。")) return;
  const r = await api("/api/noise_bias/rebuild", { method: "POST" });
  $("biasHint").textContent = r.ok ? r.msg : ("重建失败: " + (r.error || ""));
  if (r.ok) loadBiasInfo();
};

function buildPayload() {
  const p = collectSettings();
  if ($("enhCompat").checked) {
    p.sampler = "euler"; p.scheduler = "normal"; p.cfg = 5; p.clip_skip = 1;
  }
  if ($("idOn").checked && ID_IMAGE) {
    p.ipadapter = {
      enabled: true, image: ID_IMAGE,
      weight: parseFloat($("idWeight").value),
      weight_type: $("idType").value,
      preset: $("idPreset").value,
    };
  }
  return p;
}

async function addFav(img, settings) {
  FAVS_CACHE.unshift({ id: Date.now().toString(36), img, settings, time: Date.now() });
  await saveFavs();
  updateFavCount();
  renderFavs();
}

function removeFav(id) {
  FAVS_CACHE = FAVS_CACHE.filter(f => f.id !== id);
  saveFavs();
  updateFavCount();
  renderFavs();
}

function applySettings(s) {
  for (const k of CONTROLS) {
    if (s[k] === undefined) continue;
    const el = $(k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!s[k];
    else el.value = s[k];
  }
  const box = $("loraList");
  box.innerHTML = "";
  if (s.loras && s.loras.length) s.loras.forEach(l => addLoraRow(l.name, l.weight));
  else addLoraRow();
  saveSettings();
}

function imgUrl(img, thumb) {
  const base = thumb ? "/api/thumb" : "/api/image";
  return `${base}?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${img.type || "output"}`;
}

// 已删除图片记录（sessionStorage，防轮询重新渲染）
let DELETED = new Set();
try { DELETED = new Set(JSON.parse(sessionStorage.getItem("genui_deleted") || "[]")); } catch (e) {}
function markDeleted(fn) {
  DELETED.add(fn);
  sessionStorage.setItem("genui_deleted", JSON.stringify([...DELETED]));
  // 同步清理任务卡的 items/cards，全删的任务直接从缓存移除（防残留导致按钮/卡片异常）
  for (const [id, e] of TASK_CARDS) {
    if (e.items) e.items = e.items.filter(i => i.filename !== fn);
    if (e.cards) e.cards = e.cards.filter(c => c.dataset.fn !== fn);
    if (e.kind === "done" && e.items.length === 0) {
      for (const c of e.cards) c.remove();
      TASK_CARDS.delete(id);
    }
  }
}

// 收藏：滑动式翻页（每页按面板高度自适应条数，◀ ▶ 圆点 + 触摸滑动）
let FAV_PAGE = 0, FAV_PER = 5;
let favTouchX = null;

function favPerPage() {
  const list = $("favList");
  const h = list.clientHeight || 320;
  return Math.max(1, Math.floor((h - 12) / 84));
}

function renderFavs() {
  const list = $("favList");
  const favs = getFavs();
  if (!favs.length) {
    list.innerHTML = '<div class="hint" style="padding:10px">还没有收藏</div>';
    return;
  }
  FAV_PER = favPerPage();
  const pages = Math.max(1, Math.ceil(favs.length / FAV_PER));
  if (FAV_PAGE >= pages) FAV_PAGE = pages - 1;
  const start = FAV_PAGE * FAV_PER;
  const pageItems = favs.slice(start, start + FAV_PER);

  list.innerHTML = "";
  const stage = document.createElement("div");
  stage.className = "fav-stage";
  const track = document.createElement("div");
  track.className = "fav-track";
  stage.appendChild(track);
  list.appendChild(stage);

  // 导航：◀ 圆点 ▶
  const nav = document.createElement("div");
  nav.className = "fav-nav";
  const prev = document.createElement("button");
  prev.textContent = "◀";
  prev.disabled = FAV_PAGE <= 0;
  prev.onclick = () => { FAV_PAGE--; renderFavs(); };
  const dots = document.createElement("div");
  dots.className = "fav-dots";
  for (let i = 0; i < pages; i++) {
    const d = document.createElement("span");
    d.className = "fav-dot" + (i === FAV_PAGE ? " on" : "");
    d.title = "第 " + (i + 1) + " 页";
    d.onclick = () => { FAV_PAGE = i; renderFavs(); };
    dots.appendChild(d);
  }
  const next = document.createElement("button");
  next.textContent = "▶";
  next.disabled = FAV_PAGE >= pages - 1;
  next.onclick = () => { FAV_PAGE++; renderFavs(); };
  nav.append(prev, dots, next);
  list.appendChild(nav);

  // 滑动入场动画
  track.style.transition = "none";
  track.style.transform = "translateX(28px)";
  requestAnimationFrame(() => {
    track.style.transition = "transform .22s ease";
    track.style.transform = "translateX(0)";
  });

  for (const f of pageItems) {
    const item = document.createElement("div");
    item.className = "fav-item";
    const im = document.createElement("img");
    im.src = imgUrl(f.img);
    const lbFound = LB_ALL.find(x => x.url === imgUrl(f.img));
    im.onclick = () => lbFound
      ? openLightbox(lbFound.url, lbFound.name, lbFound.settings, LB_ALL, LB_ALL.indexOf(lbFound))
      : openLightbox(imgUrl(f.img), "收藏图片", f.settings);
    const info = document.createElement("div");
    info.className = "f-info";
    const pr = document.createElement("div");
    pr.className = "f-prompt";
    pr.textContent = (f.settings.prompt || "").slice(0, 120);
    const acts = document.createElement("div");
    acts.className = "f-actions";
    const b1 = document.createElement("button");
    b1.textContent = "填入";
    b1.onclick = () => { applySettings(f.settings); $("favPanel").classList.add("hidden"); };
    const b2 = document.createElement("button");
    b2.textContent = "重新生成";
    b2.onclick = () => { applySettings(f.settings); submitGen(); $("favPanel").classList.add("hidden"); };
    const b3 = document.createElement("button");
    b3.textContent = "删";
    b3.className = "f-del";
    b3.onclick = () => removeFav(f.id);
    acts.append(b1, b2, b3);
    info.append(pr, acts);
    item.append(im, info);
    track.appendChild(item);
  }
}

// 触摸左右滑动翻页（事件委托，favList 内容会重建）
$("favList").addEventListener("touchstart", e => { favTouchX = e.touches[0].clientX; }, { passive: true });
$("favList").addEventListener("touchend", e => {
  if (favTouchX === null) return;
  const dx = e.changedTouches[0].clientX - favTouchX;
  if (Math.abs(dx) > 50) {
    if (dx < 0) FAV_PAGE++; else FAV_PAGE--;
    renderFavs();
  }
  favTouchX = null;
}, { passive: true });

$("favBtn").onclick = () => {
  renderFavs();
  $("favPanel").classList.toggle("hidden");
};
$("favClose").onclick = () => $("favPanel").classList.add("hidden");

// ---------- 初始化 ----------
async function init() {
  loadSettings();
  updateFavCount();
  try {
    const [ck, lr, vae] = await Promise.all([
      api("/api/checkpoints"), api("/api/loras"), api("/api/vaes"),
    ]);
    if (ck.ok && lr.ok && vae.ok) {
      $("conn").textContent = "已连接";
      $("conn").classList.add("ok");
      $("ckpt").innerHTML = ck.items.map(n => `<option>${n}</option>`).join("");
      $("vae").innerHTML = vae.items.map(n => `<option>${n}</option>`).join("");
      window.LORAS = lr.items;
      const pend = window.PENDING_LORAS;
      if (pend && pend.length) pend.forEach(l => addLoraRow(l.name, l.weight));
      else addLoraRow();
      const s = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
      for (const id of ["ckpt", "vae"]) {
        if (s[id] && $(id).querySelector(`option[value="${s[id]}"]`)) $(id).value = s[id];
      }
      // 默认模型固定 waiIllustriousSDXL_v170（pornmaster 换序后也不再作为默认）
      if (ck.items.includes("waiIllustriousSDXL_v170.safetensors") &&
          (!s.ckpt || s.ckpt === "pornmaster_proSDXLV8.safetensors")) {
        $("ckpt").value = "waiIllustriousSDXL_v170.safetensors";
      }
    } else {
      $("conn").textContent = "连接失败";
      $("conn").classList.add("bad");
      addLoraRow();
    }
    refreshTriggers();
    loadCovers().then(() => { refreshLoraThumbs(); rebuildLoraSelects(); renderCgalTabs(); });
    loadRatings();
    loadBiasInfo();
  } catch (e) {
    $("conn").textContent = "连接失败";
    $("conn").classList.add("bad");
    addLoraRow();
  }
}

function addLoraRow(name = "", weight = 0.8) {
  const box = $("loraList");
  const row = document.createElement("div");
  row.className = "lora-row";
  const thumb = document.createElement("img");
  thumb.className = "lora-thumb"; thumb.alt = ""; thumb.title = "点开画廊选 LoRA";
  thumb.style.display = "none";
  const sel = document.createElement("select");
  sel.innerHTML = loraOptionsHtml(name);
  const w = document.createElement("input");
  w.type = "number"; w.step = "0.05"; w.min = "0"; w.max = "2"; w.value = weight;
  const gal = document.createElement("button");
  gal.className = "gal"; gal.textContent = "🖼"; gal.title = "画廊选 LoRA";
  gal.onclick = () => openCoverGallery(sel);
  const del = document.createElement("button");
  del.className = "del"; del.textContent = "✕";
  del.onclick = () => { row.remove(); saveSettings(); };
  sel.onchange = () => { updateRowThumb(thumb, sel.value); saveSettings(); };
  w.oninput = saveSettings;
  thumb.onclick = () => openCoverGallery(sel);
  row.append(thumb, sel, w, gal, del);
  box.appendChild(row);
  updateRowThumb(thumb, sel.value);
}

$("addLora").onclick = () => { addLoraRow(); saveSettings(); };

// ---------- 图片评分（1-5 星；打分时把提示词与生成参数一起快照到服务器，图片被刷掉也不丢） ----------
let RATINGS = {};        // {文件名: {score, prompt, negative, seq, task, ts, settings}}
let RATING_COUNTS = {};  // {"1":n ... "5":n}

async function loadRatings() {
  try {
    const r = await api("/api/ratings");
    if (r && r.ok) {
      RATINGS = r.items || {};
      renderRatingSummary(r.counts, r.total);
      syncStars();
    }
  } catch (e) {}
}

function scoreOf(name) { return (RATINGS[name] && RATINGS[name].score) || 0; }

async function setScore(name, score, settings, taskId) {
  if (!name) { $("status").textContent = "拿不到文件名，先打开大图再打分"; return; }
  const st = settings || (RATINGS[name] && RATINGS[name].settings) || {};
  try {
    const r = await api("/api/rate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: name, score,
        prompt: st.prompt || "", negative: st.negative || "",
        settings: st, task: taskId || "",
      }),
    });
    if (!r.ok) { $("status").textContent = "打分失败: " + (r.error || ""); return; }
    RATINGS = r.items || RATINGS;
    renderRatingSummary(r.counts, r.total);
    syncStars();
    $("status").textContent = score ? `已打 ${score} 分（提示词与参数已存）` : "已取消评分";
  } catch (e) {
    $("status").textContent = "打分失败";
  }
}

function starRow(name, settings, big) {
  const box = document.createElement("div");
  box.className = "stars" + (big ? " stars-big" : "");
  box.dataset.fn = name || "";
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement("button");
    b.className = "star"; b.type = "button"; b.dataset.v = i; b.textContent = "★";
    b.title = `${i} 分（再点同分 = 取消）`;
    b.onclick = (e) => {
      e.stopPropagation();
      setScore(name, scoreOf(name) === i ? 0 : i, settings);
    };
    box.appendChild(b);
  }
  paintStars(box, scoreOf(name));
  return box;
}

function paintStars(box, score) {
  box.querySelectorAll(".star").forEach((b, idx) => b.classList.toggle("on", idx < score));
  box.dataset.score = score || 0;
}

function syncStars() {
  document.querySelectorAll(".stars[data-fn]").forEach(b => paintStars(b, scoreOf(b.dataset.fn)));
}

function lbFilename(it) {
  if (it && it.filename) return it.filename;
  const m = /[?&]filename=([^&]+)/.exec((it && it.url) || "");
  return m ? decodeURIComponent(m[1]) : "";
}

function ratingText() {
  const lines = ["# 图片评分清单（1-5 星）：分 \t 序号 \t 文件 \t 提示词",
                 "# 合计: " + Object.keys(RATINGS).length + " 张", ""];
  for (let s = 5; s >= 1; s--) {
    const rows = Object.keys(RATINGS).filter(n => RATINGS[n].score === s)
      .sort((a, b) => (RATINGS[a].seq || 0) - (RATINGS[b].seq || 0));
    lines.push(`## ${s} 星（${rows.length} 张）`);
    rows.forEach(n => lines.push(`${s}\t${RATINGS[n].seq != null ? RATINGS[n].seq : ""}\t${n}\t${RATINGS[n].prompt || ""}`));
    lines.push("");
  }
  return lines.join("\n");
}

function renderRatingSummary(counts, total) {
  if (counts) RATING_COUNTS = counts;
  const n = total != null ? total : Object.keys(RATINGS).length;
  const badge = $("rateCount");
  if (badge) badge.textContent = n;
  const body = $("rateBody");
  if (!body) return;
  body.innerHTML = "";
  const legend = document.createElement("div");
  legend.className = "rate-legend";
  legend.textContent = "口径：5 收藏 / 4 优秀 / 3 正常 / 2 有显著问题 / 1 完全用不了（噪声偏向只用 4-5 和 1-2，3 不参与）";
  body.appendChild(legend);
  if (!n) {
    const p = document.createElement("div");
    p.className = "rate-empty";
    p.textContent = "还没有评分。图片卡片下面点星星，或打开大图后按键盘 1-5 快速打分（打完自动下一张）。\n口径：5 收藏 / 4 优秀 / 3 正常 / 2 有显著问题 / 1 完全用不了。提示词和生成参数会一起存到服务器，图片被刷掉也不会丢。";
    body.appendChild(p);
    return;
  }
  for (let s = 5; s >= 1; s--) {
    const rows = Object.keys(RATINGS).filter(x => RATINGS[x].score === s)
      .sort((a, b) => (RATINGS[a].seq || 0) - (RATINGS[b].seq || 0));
    const sec = document.createElement("div");
    sec.className = "rate-sec";
    const h = document.createElement("div");
    h.className = "rate-sec-h";
    h.textContent = `${s} 星 · ${RATE_LABEL[s] || ""} `;
    const sp = document.createElement("span");
    sp.textContent = `${rows.length} 张`;
    h.appendChild(sp);
    sec.appendChild(h);
    if (rows.length) {
      const box = document.createElement("div");
      box.className = "rate-names";
      box.textContent = rows.map(nm => {
        const v = RATINGS[nm];
        const seq = v.seq != null ? `#${v.seq} ` : "";
        return `${RATE_LABEL[v.score] || v.score}★ ${seq}${nm}\n    ${(v.prompt || "（无提示词快照）").slice(0, 160)}`;
      }).join("\n");
      sec.appendChild(box);
    }
    body.appendChild(sec);
  }
}

$("rateBtn").onclick = async () => {
  const p = $("ratePanel");
  const show = p.classList.contains("hidden");
  p.classList.toggle("hidden", !show);
  $("favPanel").classList.add("hidden");
  if (show) { await loadRatings(); renderRatingSummary(RATING_COUNTS, Object.keys(RATINGS).length); }
};
$("rateClose").onclick = () => $("ratePanel").classList.add("hidden");
$("rateCopy").onclick = async () => {
  const txt = ratingText();
  try {
    await navigator.clipboard.writeText(txt);
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  $("status").textContent = "评分清单已复制";
};

// ---------- LoRA 画廊 ----------
let COVERS = null;      // {lora文件名: {cover, trigger, kind}}，null = 尚未加载
let cgalTarget = null;  // 画廊要写回的那一行 <select>
let cgalKind = "";      // 画廊分类筛选（"" = 全部）
const KIND_LABEL = { character: "角色", style: "画风", content: "内容", other: "其他" };
const KIND_ORDER = ["character", "style", "content", "other"];

function kindOf(name) {
  const c = COVERS && COVERS[name];
  return (c && c.kind) || "other";
}

// LoRA 下拉框：有类别数据时按 角色/画风/内容/其他 分组（optgroup）
function loraOptionsHtml(selected) {
  const names = window.LORAS || [];
  const grouped = COVERS && names.some(n => COVERS[n] && COVERS[n].kind);
  const one = n => `<option ${n === selected ? "selected" : ""}>${n}</option>`;
  if (!grouped) return names.map(one).join("");
  const groups = {};
  names.forEach(n => { const k = kindOf(n); (groups[k] = groups[k] || []).push(n); });
  return KIND_ORDER.filter(k => groups[k]).map(k =>
    `<optgroup label="${KIND_LABEL[k] || k} (${groups[k].length})">` +
    groups[k].map(one).join("") + "</optgroup>").join("");
}

function rebuildLoraSelects() {
  document.querySelectorAll(".lora-row").forEach(r => {
    const sel = r.querySelector("select");
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = loraOptionsHtml(cur);
    if (cur) sel.value = cur;
  });
}

function renderCgalTabs() {
  const box = $("cgalTabs");
  if (!box) return;
  const names = window.LORAS || [];
  const counts = {};
  names.forEach(n => { const k = kindOf(n); counts[k] = (counts[k] || 0) + 1; });
  const items = [["", "全部", names.length]]
    .concat(KIND_ORDER.filter(k => counts[k]).map(k => [k, KIND_LABEL[k] || k, counts[k]]));
  box.innerHTML = "";
  items.forEach(([k, label, n]) => {
    const b = document.createElement("button");
    b.className = "cgal-tab" + (k === cgalKind ? " on" : "");
    b.textContent = `${label} ${n}`;
    b.onclick = () => {
      cgalKind = k;
      renderCgalTabs();
      renderCoverGallery($("cgalSearch").value, cgalTarget ? cgalTarget.value : "");
    };
    box.appendChild(b);
  });
}

async function loadCovers() {
  if (COVERS) return COVERS;
  try {
    const r = await api("/api/covers");
    COVERS = (r && r.items) || {};
    if (r && r.generated_at) COVERS.generated_at = r.generated_at;
  } catch (e) {
    COVERS = {};
  }
  return COVERS;
}

function coverOf(name) {
  const c = COVERS && COVERS[name];
  return c && c.cover ? "/covers/" + encodeURIComponent(c.cover) : "";
}

function updateRowThumb(img, name) {
  const url = coverOf(name);
  if (url) { img.src = url; img.style.display = ""; }
  else { img.removeAttribute("src"); img.style.display = "none"; }
}

function refreshLoraThumbs() {
  document.querySelectorAll(".lora-row").forEach(r => {
    const img = r.querySelector(".lora-thumb"), sel = r.querySelector("select");
    if (img && sel) updateRowThumb(img, sel.value);
  });
}

async function openCoverGallery(sel) {
  cgalTarget = sel || document.querySelector(".lora-row select");
  await loadCovers();
  renderCgalTabs();
  renderCoverGallery("", cgalTarget ? cgalTarget.value : "");
  $("coverGallery").classList.remove("hidden");
  setTimeout(() => $("cgalSearch").focus(), 30);
}

function closeCoverGallery() {
  $("coverGallery").classList.add("hidden");
  cgalTarget = null;
}

function renderCoverGallery(q, cur) {
  const grid = $("cgalGrid");
  if (!grid) return;
  const names = window.LORAS || [];
  const query = (q || "").trim().toLowerCase();
  const shown = names.filter(n => {
    if (cgalKind && kindOf(n) !== cgalKind) return false;
    if (!query) return true;
    const t = (COVERS && COVERS[n] && COVERS[n].trigger) || "";
    return n.toLowerCase().includes(query) || t.toLowerCase().includes(query);
  });
  grid.innerHTML = "";
  shown.forEach(n => {
    const c = (COVERS && COVERS[n]) || {};
    const url = coverOf(n);
    const card = document.createElement("div");
    card.className = "cgal-card" + (n === cur ? " sel" : "");
    card.appendChild(url
      ? Object.assign(document.createElement("img"),
          { className: "c-thumb", src: url, loading: "lazy", alt: "" })
      : Object.assign(document.createElement("div"),
          { className: "c-noimg", textContent: c.error ? "生成失败" : "无封面" }));
    const meta = document.createElement("div");
    meta.className = "c-meta";
    const nm = document.createElement("div");
    nm.className = "c-name"; nm.textContent = n.replace(/\.safetensors$/, ""); nm.title = n;
    const tg = document.createElement("div");
    tg.className = "c-trig";
    tg.textContent = c.trigger ? "触发词 " + c.trigger : "";
    const bd = document.createElement("span");
    bd.className = "c-kind k-" + kindOf(n);
    bd.textContent = KIND_LABEL[kindOf(n)] || "其他";
    nm.appendChild(bd);
    meta.append(nm, tg);
    card.appendChild(meta);
    card.onclick = () => {
      if (cgalTarget) { cgalTarget.value = n; refreshLoraThumbs(); renderTriggers(); saveSettings(); }
      closeCoverGallery();
    };
    grid.appendChild(card);
  });
  const foot = $("cgalFoot");
  if (foot) {
    const withCover = names.filter(n => coverOf(n)).length;
    foot.textContent = `共 ${names.length} 个 LoRA，${withCover} 个有封面 · 显示 ${shown.length} 个`
      + (COVERS && COVERS.generated_at ? ` · 封面生成于 ${COVERS.generated_at}` : "");
  }
}

$("cgalClose").onclick = closeCoverGallery;
$("coverGallery").onclick = (e) => { if (e.target.id === "coverGallery") closeCoverGallery(); };
$("cgalSearch").oninput = (e) => renderCoverGallery(e.target.value, cgalTarget ? cgalTarget.value : "");
$("galleryBtn").onclick = () => openCoverGallery(document.querySelector(".lora-row select"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("coverGallery").classList.contains("hidden")) closeCoverGallery();
});

document.querySelectorAll(".chip").forEach(ch => {
  ch.onclick = () => { $("width").value = ch.dataset.w; $("height").value = ch.dataset.h; saveSettings(); };
});

$("seedRandom").onclick = () => {
  $("seed").value = Math.floor(Math.random() * 2**31);
  saveSettings();
};

// ---------- 导入模型 ----------
$("importBtn").onclick = () => {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".safetensors";
  inp.onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const kind = f.size > 1024 * 1024 * 1024 ? "checkpoint" :
      (confirm("导入为 LoRA？（取消 = 作为 Checkpoint）") ? "lora" : "checkpoint");
    const fd = new FormData();
    fd.append("file", f);
    fd.append("kind", kind);
    $("status").textContent = `导入中 (${(f.size/1e6).toFixed(0)} MB)... 上传到服务器可能需要几分钟`;
    const r = await api("/api/import", { method: "POST", body: fd });
    if (r.ok) {
      $("status").textContent = `导入完成: ${r.name} → ${r.dest}`;
      // 刷新列表
      const [ck, lr] = await Promise.all([api("/api/checkpoints"), api("/api/loras")]);
      const prevCk = $("ckpt").value;
      $("ckpt").innerHTML = ck.items.map(n => `<option>${n}</option>`).join("");
      if (ck.items.includes(prevCk)) $("ckpt").value = prevCk;
      else if (ck.items.includes("waiIllustriousSDXL_v170.safetensors")) $("ckpt").value = "waiIllustriousSDXL_v170.safetensors";
      window.LORAS = lr.items;
      addLoraRow(r.name);
    } else {
      $("status").textContent = "导入失败: " + r.error;
    }
  };
  inp.click();
};

// ---------- 豪横预设 ----------
$("luxBtn").onclick = () => {
  $("steps").value = 28;
  $("cfg").value = 6;
  $("sampler").value = "dpmpp_2m";
  $("scheduler").value = "karras";
  const extra = "score_9, score_8_up, score_7_up, best quality, amazing quality, very aesthetic, absurdres";
  const cur = $("prompt").value.trim();
  const has = ["score_9", "best quality", "absurdres"].some(t => cur.includes(t));
  if (cur && !has) $("prompt").value = cur + ", " + extra;
  else if (!cur) $("prompt").value = extra;
  if (!$("negative").value.trim()) {
    $("negative").value = "(text:1.5), (watermark:1.5), (signature:1.5), (logo:1.5), (letter:1.4), (caption:1.4), (subtitles:1.4), (ui:1.4), (border:1.4), (frame:1.4), (speech bubble:1.4), (dialogue:1.4), (sound effect:1.4), (sfx:1.4), (japanese text:1.4), (english text:1.4), (typography:1.4), (kana:1.4), (kanji:1.4), (katakana:1.4), (hiragana:1.4), (words:1.3), (writing:1.3), (font:1.3), (label:1.3), (slogan:1.3), (title:1.3), (header:1.3), (footer:1.3), (menu:1.3), (icons:1.3), (number:1.3), (timestamp:1.3), (date:1.3), (url:1.3), (email:1.3), (barcode:1.3), (qr code:1.3), lowres, bad anatomy, bad hands, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, blurry";
  }
  saveSettings();
  $("status").textContent = "已应用豪横预设";
};

// ---------- 触发词按钮 ----------
let TRIGGERS = { checkpoints: {}, loras: {} };

async function refreshTriggers() {
  try {
    const r = await api("/api/triggers");
    if (r.ok) {
      TRIGGERS = r;
      renderTriggers();
    }
  } catch (e) {}
}

function renderTriggers() {
  const box = $("triggers");
  if (!box) return;
  const words = [];
  const ck = $("ckpt").value;
  if (ck && TRIGGERS.checkpoints[ck]) words.push(...TRIGGERS.checkpoints[ck]);
  document.querySelectorAll(".lora-row select").forEach(sel => {
    const v = sel.value;
    if (v && TRIGGERS.loras[v]) words.push(...TRIGGERS.loras[v]);
  });
  const uniq = [...new Set(words)];
  box.innerHTML = "";
  if (!uniq.length) return;
  const lab = document.createElement("span");
  lab.className = "trig-label";
  lab.textContent = "触发词:";
  box.appendChild(lab);
  for (const w of uniq) {
    const b = document.createElement("button");
    b.className = "trig";
    b.textContent = w;
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(w);
      } catch (e) {
        // 兼容非 https 环境
        const ta = document.createElement("textarea");
        ta.value = w;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      b.textContent = "✓ 已复制";
      b.classList.add("copied");
      setTimeout(() => { b.textContent = w; b.classList.remove("copied"); }, 1200);
    };
    box.appendChild(b);
  }
}

$("ckpt").addEventListener("change", renderTriggers);
$("loraList").addEventListener("change", renderTriggers);

// ---------- 手机端 Tab 切换 ----------
document.querySelectorAll(".tab").forEach(t => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    const page = t.dataset.page;
    document.querySelectorAll(".page-gen, .page-imgs").forEach(x => x.classList.remove("active"));
    document.querySelector(`.page-${page}`).classList.add("active");
  };
});

// ---------- 生成（队列） ----------
async function submitGen() {
  const payload = buildPayload();
  $("status").textContent = "已加入队列";
  const resp = await api("/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) { $("status").textContent = "错误: " + resp.error; return; }
  $("status").textContent = "任务 " + resp.task_id + " 已入队" +
    ((resp.bias_notes || []).length ? " · " + resp.bias_notes.join("; ") : "");
  // 移动端自动切到图片页看进度
  if (getComputedStyle($("tabbar")).display !== "none") {
    document.querySelector(".tab[data-page=imgs]").click();
  }
}

$("genBtn").onclick = submitGen;

// ---------- 实例复位（服务器自助，无需本地网关） ----------
let instTimer = null;

$("instBtn").onclick = async () => {
  const text = $("instInput").value.trim();
  const out = $("instOut");
  if (!text) { out.textContent = "先粘贴 ssh 信息"; return; }
  $("instBtn").disabled = true;
  out.textContent = "提交复位…";
  try {
    const r = await api("/api/instance", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    out.textContent = r.ok
      ? "已保存，后台恢复中（页面会断一下，1-2 分钟自动回来）…\n" + (r.note || "")
      : "失败: " + (r.error || "");
    if (r.ok && r.restored) pollInstStatus();
  } catch (e) {
    out.textContent = "提交失败: " + e.message;
  }
  $("instBtn").disabled = false;
};

async function pollInstStatus() {
  try {
    const r = await api("/api/instance/status");
    if (!r.ok) return;
    const out = $("instOut");
    out.textContent = (r.log || "").trim() || "恢复中…";
    if (r.alive && /\[OK\]/.test(r.log || "")) {
      out.textContent += "\n\n✅ 服务已恢复，可正常生成";
      return;
    }
    if (/\[WARN\]|\[FATAL\]/.test(r.log || "")) return;  // 恢复失败，停在日志
  } catch (e) {
    // 恢复期间 genui 被重启，连接会断，属正常，继续轮询
    if (/\[OK\]/.test(out.textContent)) return;
  }
  instTimer = setTimeout(pollInstStatus, 4000);
}

// ---------- tag 联想 ----------
let suggestTimer = null;
let suggestItems = [];
let suggestIdx = -1;
const promptEl = $("prompt");
const suggestBox = document.createElement("div");
suggestBox.id = "suggestBox";
suggestBox.style.cssText = "position:absolute;z-index:99;background:#26263d;border:1px solid #444;border-radius:8px;max-height:220px;overflow-y:auto;display:none;min-width:260px;font-size:13px";
promptEl.parentElement.style.position = "relative";
promptEl.parentElement.appendChild(suggestBox);

function currentTag() {
  const v = promptEl.value;
  const pos = promptEl.selectionStart ?? v.length;
  const before = v.slice(0, pos);
  // 逗号和换行都是词段分隔符（取靠后的那个，防止换行被算进当前词）
  const lastSep = Math.max(before.lastIndexOf(","), before.lastIndexOf("\n"));
  let start = lastSep + 1;
  while (start < before.length && v[start] === " ") start++;
  const cur = before.slice(start);
  return { cur, start };
}

let suggestStart = -1;  // fetchSuggest 成功时记录的当前词起点（防点击时 selection 丢失）

async function fetchSuggest() {
  const { cur, start } = currentTag();
  if (!cur || cur.length < 1 || /[()]/.test(cur) || cur.includes("\n")) {
    suggestStart = -1;
    suggestBox.style.display = "none";
    return;
  }
  try {
    const resp = await fetch("/api/tag_suggest?q=" + encodeURIComponent(cur));
    const j = await resp.json();
    suggestItems = j.items || [];
    suggestStart = start;
    suggestIdx = -1;
    if (!suggestItems.length) { suggestBox.style.display = "none"; return; }
    suggestBox.innerHTML = "";
    suggestItems.forEach((t, i) => {
      const d = document.createElement("div");
      d.textContent = t;
      d.style.cssText = "padding:5px 10px;cursor:pointer;white-space:nowrap";
      d.onmouseenter = () => { suggestIdx = i; paintSuggest(); };
      d.onclick = () => pickSuggest(i);
      suggestBox.appendChild(d);
    });
    paintSuggest();
    // 绝对定位贴住输入框底部（相对 prompt 的父容器），不遮挡输入框
    suggestBox.style.position = "absolute";
    suggestBox.style.left = "0px";
    suggestBox.style.top = (promptEl.offsetTop + promptEl.offsetHeight + 4) + "px";
    suggestBox.style.width = Math.max(promptEl.offsetWidth, 260) + "px";
    suggestBox.style.display = "block";
  } catch (e) {
    suggestBox.style.display = "none";
  }
}

function paintSuggest() {
  [...suggestBox.children].forEach((d, i) => {
    d.style.background = i === suggestIdx ? "#3a3a5c" : "transparent";
  });
}

function pickSuggest(i) {
  if (i < 0 || i >= suggestItems.length) return;
  const v = promptEl.value;
  // 用联想请求时记录的词起点；异常时回退到 currentTag
  let start = suggestStart;
  if (start < 0 || start > v.length) start = currentTag().start;
  // 从起点到下一个分隔符（逗号或换行）/末尾 = 整个当前词段（无论光标在哪都整体替换，避免残留）
  let end = start;
  while (end < v.length && v[end] !== "," && v[end] !== "\n") end++;
  const after = v.slice(end);
  // 词段后是分隔符（逗号/换行）就原样保留，否则补 ", "，绝不吞掉后面的内容
  const sep = after ? (after.startsWith(",") || after.startsWith("\n") ? after : ", " + after) : "";
  promptEl.value = v.slice(0, start) + suggestItems[i] + sep;
  const np = start + suggestItems[i].length + 1;
  promptEl.setSelectionRange(np, np);
  suggestBox.style.display = "none";
  promptEl.focus();
}

promptEl.addEventListener("input", () => {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(fetchSuggest, 200);
});
promptEl.addEventListener("keydown", (e) => {
  if (suggestBox.style.display === "none") return;
  if (e.key === "ArrowDown") { e.preventDefault(); suggestIdx = (suggestIdx + 1) % suggestItems.length; paintSuggest(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); suggestIdx = (suggestIdx - 1 + suggestItems.length) % suggestItems.length; paintSuggest(); }
  else if (e.key === "Enter" && suggestIdx >= 0) { e.preventDefault(); pickSuggest(suggestIdx); }
  else if (e.key === "Escape") { suggestBox.style.display = "none"; }
});
document.addEventListener("click", (e) => {
  if (!suggestBox.contains(e.target) && e.target !== promptEl) suggestBox.style.display = "none";
});

// ---------- img2img 参考图上传 ----------
let REF_FILE = null;
// ---------- img2img 卡片收起/展开（默认收起，点开全部显示，状态持久化） ----------
function applyI2iCollapse() {
  const collapsed = localStorage.getItem("i2iCollapsed") !== "0";
  $("i2iBody").style.display = collapsed ? "none" : "block";
  $("i2iArrow").textContent = collapsed ? "▸" : "▾";
}
applyI2iCollapse();
$("i2iToggle").onclick = () => {
  const collapsed = localStorage.getItem("i2iCollapsed") !== "0";
  localStorage.setItem("i2iCollapsed", collapsed ? "0" : "1");
  applyI2iCollapse();
};

$("refFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  REF_FILE = f;
  const fd = new FormData();
  fd.append("file", f);
  $("status").textContent = "上传参考图...";
  try {
    const resp = await fetch("/api/upload", { method: "POST", body: fd });
    const j = await resp.json();
    if (!j.ok) { $("status").textContent = "上传失败: " + j.error; return; }
    REF_IMAGE = j.name;
    $("refName").textContent = j.name;
    $("refPreview").src = URL.createObjectURL(f);
    $("refPreview").style.display = "block";
    $("status").textContent = "参考图已上传: " + j.name;
  } catch (err) {
    $("status").textContent = "上传失败: " + err;
  }
});

// 二次采样（生成后高清）
async function upscaleImage(img) {
  const scale = prompt("放大倍率（1.5 = 1.5x）", "1.5") || "";
  if (!scale) return;
  const denoise = prompt("重绘幅度（0.2-0.6，越大越偏离原图）", "0.4") || "";
  if (!denoise) return;
  $("status").textContent = "二次采样任务已入队...";
  const r = await api("/api/upscale", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: img.filename, scale: parseFloat(scale), denoise: parseFloat(denoise) }),
  });
  if (r.ok) $("status").textContent = "高清任务 " + r.task_id + " 已入队";
  else $("status").textContent = "失败: " + r.error;
}

// ---------- 任务列表 + 画廊 ----------
// 全部已完成图片（跨任务左右切换用）
let LB_ALL = [];
function settingsSummary(s) {
  if (!s) return "";
  const l = (s.loras || []).map(x => `${x.name.split(".")[0]}:${x.weight}`).join(", ");
  return [
    `Checkpoint: ${(s.checkpoint || "").split(".")[0]}`,
    l ? `LoRA: ${l}` : "",
    `Steps ${s.steps} / CFG ${s.cfg} / ${s.sampler} ${s.scheduler}`,
    `${s.width}x${s.height} / seed ${s.seed} / batch ${s.batch}`,
    s.hires ? `Hires ${s.hires_scale}x d${s.hires_denoise}` : "",
    s.clip_skip > 1 ? `CLIP Skip ${s.clip_skip}` : "",
  ].filter(Boolean).join("\n");
}

// 任务卡缓存：按任务 id 增量渲染（不每轮清空重建，图片不重复加载）
const TASK_CARDS = new Map();

function createPendingCard(t) {
  const card = document.createElement("div");
  card.className = "img-card pending";
  const ph = document.createElement("div");
  ph.className = "pending-ph";
  const prog = document.createElement("div");
  prog.className = "prog";
  const fill = document.createElement("div");
  fill.className = "prog-fill";
  prog.appendChild(fill);
  const bar = document.createElement("div");
  bar.className = "bar";
  const pr = document.createElement("span");
  pr.className = "t-prompt";
  pr.textContent = (t.prompt || "").slice(0, 60);
  const cancel = document.createElement("button");
  cancel.className = "cancel-btn";
  cancel.textContent = "删除任务";
  cancel.title = "取消并删除此任务";
  cancel.onclick = async () => {
    cancel.disabled = true;
    try {
      const r = await api("/api/cancel", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task_id: t.id }),
      });
      if (r.ok) {
        // 立即移除卡片，不等下一轮轮询
        card.remove();
        TASK_CARDS.delete(t.id);
      } else {
        cancel.disabled = false;
        $("status").textContent = "取消失败: " + (r.error || "");
      }
    } catch (e) { cancel.disabled = false; }
  };
  bar.appendChild(pr);
  bar.appendChild(cancel);
  card.append(ph, prog, bar);
  const entry = { kind: "pending", card, ph, fill, cancelBtn: cancel };
  updatePendingCard(entry, t);
  return entry;
}

function updatePendingCard(entry, t) {
  const stageMap = { queued: "排队中", preparing: "准备中", sampling: "采样中", finishing: "收尾中" };
  const stageText = stageMap[t.stage] || (t.status === "queued" ? "排队中" : "生成中");
  const pct = t.progress != null ? Math.round(t.progress * 100) : 0;
  entry.ph.innerHTML = `<span class="spinner"></span><div>${stageText}${t.stage === "sampling" ? ` ${pct}%` : ""}</div>`;
  const fillW = t.stage === "sampling" || t.stage === "finishing" ? Math.max(pct, 3) : 3;
  entry.fill.style.width = fillW + "%";
  // 确保删除任务按钮存在（任何情况下都补上）
  if (!entry.cancelBtn || !entry.cancelBtn.isConnected) {
    const bar = entry.card.querySelector(".bar");
    if (bar && !bar.querySelector(".cancel-btn")) {
      const cancel = document.createElement("button");
      cancel.className = "cancel-btn";
      cancel.textContent = "删除任务";
      cancel.title = "取消并删除此任务";
      cancel.onclick = async () => {
        cancel.disabled = true;
        try {
          const r = await api("/api/cancel", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ task_id: t.id }),
          });
          if (r.ok) {
            entry.card.remove();
            TASK_CARDS.delete(t.id);
          } else {
            cancel.disabled = false;
            $("status").textContent = "取消失败: " + (r.error || "");
          }
        } catch (e) { cancel.disabled = false; }
      };
      bar.appendChild(cancel);
      entry.cancelBtn = cancel;
    }
  }
}

function createStateCard(html) {
  const card = document.createElement("div");
  card.className = "img-card error";
  const ph = document.createElement("div");
  ph.className = "pending-ph";
  ph.innerHTML = html;
  card.appendChild(ph);
  return card;
}

function createDoneCard(t) {
  const items = [];
  for (const img of t.images) {
    if (DELETED.has(img.filename)) continue;
    items.push({ url: imgUrl(img), name: img.filename, settings: t.payload, filename: img.filename,
                 subfolder: img.subfolder || "", type: img.type || "output" });
  }
  if (!items.length) return { kind: "empty", cards: [], items: [] };
  const cards = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const card = document.createElement("div");
    card.className = "img-card";
    card.dataset.fn = it.filename;
    const im = document.createElement("img");
    im.src = imgUrl(it, true);
    im.loading = "lazy";
    im.decoding = "async";
    im.fetchPriority = "low";
    im.onerror = () => { im.style.visibility = "hidden"; card.style.minHeight = "120px"; };
    im.onclick = () => openLightbox(it.url, it.name, it.settings, LB_ALL, LB_ALL.indexOf(it));
    const bar = document.createElement("div");
    bar.className = "bar";
    const fav = document.createElement("button");
    fav.className = "fav-btn";
    const isFav = getFavs().some(f => f.img.filename === it.filename);
    fav.textContent = isFav ? "★" : "☆";
    fav.classList.toggle("on", isFav);
    fav.title = isFav ? "已收藏（点击取消收藏）" : "收藏此图的提示词和设置";
    fav.onclick = () => {
      if (isFav) {
        const favs = getFavs().filter(f => f.img.filename !== it.filename);
        setFavs(favs);
        renderFavs();
        fav.textContent = "☆";
        fav.classList.remove("on");
        fav.title = "收藏此图的提示词和设置";
      } else {
        addFav(it, t.payload || {});
        fav.textContent = "★";
        fav.classList.add("on");
        fav.title = "已收藏（点击取消收藏）";
      }
    };
    const up = document.createElement("button");
    up.className = "fav-btn up-btn";
    up.textContent = "✨";
    up.title = "二次采样高清（Hires Fix）";
    up.onclick = () => upscaleImage(it);
    const del = document.createElement("button");
    del.className = "fav-btn del-btn";
    del.textContent = "🗑";
    del.title = "删除此图片（服务器文件）";
    del.onclick = () => {
      if (!confirm("删除这张图片？（服务器文件将移除）")) return;
      markDeleted(it.filename);
      card.remove();
      $("status").textContent = "已删除";
      api("/api/delete_image", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: it.filename }),
      }).then(r => {
        if (!r.ok) $("status").textContent = "后台删除失败: " + (r.error || "");
      });
    };
    const dl = document.createElement("a");
    dl.href = imgUrl(it);
    dl.download = "";
    dl.textContent = "下载";
    bar.append(fav, up, del, dl);
    const rateRow = document.createElement("div");
    rateRow.className = "rate-row";
    rateRow.appendChild(starRow(it.filename, t.payload || {}, false));
    card.append(im, bar, rateRow);
    cards.push(card);
  }
  return { kind: "done", cards, items };
}

function createTaskCard(t) {
  if (t.status === "queued" || t.status === "running") return createPendingCard(t);
  if (t.status === "cancelled") return { kind: "empty", cards: [], items: [] };
  if (t.status === "error") return { kind: "state", cards: [createStateCard(`<div style="color:#e5484d">失败</div><div class="t-prompt">${(t.error || "").slice(0, 60)}</div>`)] };
  if (t.status === "done") return createDoneCard(t);
  return { kind: "empty", cards: [], items: [] };
}

function entryCards(entry) {
  return entry.kind === "pending" ? [entry.card] : (entry.cards || []);
}

async function pollTasks() {
  try {
    const r = await api("/api/tasks");
    if (!r.ok) return;
    const gal = $("gallery");
    LB_ALL = [];
    const running = r.tasks.filter(t => t.status === "running" || t.status === "queued").length;
    if (running) $("status").textContent = `队列中 ${running} 个任务...`;
    const seen = new Set();
    let shown = 0;
    let prevEntry = null;  // 前一个已渲染任务卡（新卡按列表顺序插到它后面）
    const LIMIT = 30;
    for (const t of r.tasks) {
      if (shown >= LIMIT) break;
      seen.add(t.id);
      let entry = TASK_CARDS.get(t.id);
      if (!entry) {
        entry = createTaskCard(t);
        TASK_CARDS.set(t.id, entry);
        if (entry.kind !== "empty") {
          const cards = entryCards(entry);
          if (prevEntry) {
            const pc = entryCards(prevEntry);
            pc[pc.length - 1].after(...cards);
          } else {
            gal.prepend(...cards);
          }
        }
      } else if (entry.kind === "pending" && (t.status === "queued" || t.status === "running")) {
        updatePendingCard(entry, t);
      } else if (t.status === "cancelled") {
        // 已取消：从画廊移除（不显示）
        for (const c of entryCards(entry)) c.remove();
        TASK_CARDS.delete(t.id);
      } else if (entry.kind !== "done" && t.status === "done" && t.images && t.images.length) {
        // 完成：替换为图片卡
        for (const c of entryCards(entry)) c.remove();
        entry = createTaskCard(t);
        TASK_CARDS.set(t.id, entry);
        if (entry.kind !== "empty") {
          const cards = entryCards(entry);
          if (prevEntry) {
            const pc = entryCards(prevEntry);
            pc[pc.length - 1].after(...cards);
          } else {
            gal.prepend(...cards);
          }
        }
      }
      if (entry.kind !== "empty") prevEntry = entry;
      if (entry.kind === "done") LB_ALL.push(...entry.items);
      shown += entry.kind === "done" ? Math.max(entry.items.length, 1) : 1;
    }
    // 移出列表的旧任务卡片回收
    for (const [id, e] of TASK_CARDS) {
      if (!seen.has(id)) { for (const c of entryCards(e)) c.remove(); TASK_CARDS.delete(id); }
    }
  } catch (e) { $("status").textContent = "poll error: " + (e.stack || e.message); }
}
setInterval(pollTasks, 2000);

// ---------- Lightbox：大图 + 侧边信息 + 左右切换 ----------
let lbScale = 1, lbX = 0, lbY = 0, lbDrag = null;
let LB_ITEMS = [], LB_INDEX = 0, lbTouchX = null;

function openLightbox(url, name, settings, items, index) {
  LB_ITEMS = (items && items.length) ? items : [{ url, name, settings }];
  LB_INDEX = Math.max(0, index || 0);
  showLbItem();
}

function showLbItem() {
  const it = LB_ITEMS[LB_INDEX];
  if (!it) return;
  $("lbImg").src = it.url;
  lbScale = 1; lbX = 0; lbY = 0;
  applyLbTransform();
  // 侧边信息面板
  const side = $("lbSide");
  side.innerHTML = "";
  const h = document.createElement("h4");
  h.textContent = it.name || (LB_ITEMS.length > 1 ? `${LB_INDEX + 1}/${LB_ITEMS.length}` : "图片");
  side.appendChild(h);
  const rateBox = document.createElement("div");
  rateBox.className = "lb-rate";
  const rateLab = document.createElement("div");
  rateLab.className = "lb-rate-label";
  rateLab.textContent = "评分（也可直接按 1-5 键，打完自动下一张；提示词与参数会一并存下）";
  rateBox.append(rateLab, starRow(lbFilename(it), it.settings || {}, true));
  side.appendChild(rateBox);
  if (it.settings) {
    const pre = document.createElement("pre");
    pre.className = "lb-settings";
    pre.textContent = settingsSummary(it.settings);
    side.appendChild(pre);
    const fill = document.createElement("button");
    fill.className = "btn-primary";
    fill.textContent = "📝 填入提示词及设置";
    fill.onclick = () => { applySettings(it.settings); };
    side.appendChild(fill);
    const reg = document.createElement("button");
    reg.className = "btn-ghost";
    reg.textContent = "🔄 用此设置重新生成";
    reg.onclick = () => { applySettings(it.settings); submitGen(); };
    side.appendChild(reg);
    const fav = document.createElement("button");
    fav.className = "btn-ghost";
    fav.textContent = "⭐ 收藏";
    fav.onclick = () => {
      const img = { filename: it.url.split("filename=")[1].split("&")[0], subfolder: "", type: "output" };
      addFav(img, it.settings);
    };
    side.appendChild(fav);
    // 问题检测（参数 + 图像分析），点击修复并调参
    detectIssues(it.settings, it.url).then(issues => {
      if (!issues.length) return;
      const box = document.createElement("div");
      box.className = "lb-issues";
      const th = document.createElement("div");
      th.className = "lb-issues-title";
      th.textContent = "⚠ 检测到的问题（点击自动修复）";
      box.appendChild(th);
      issues.forEach(iss => {
        const b = document.createElement("button");
        b.className = "issue-btn";
        b.textContent = iss.label;
        b.onclick = () => {
          applyIssueFix(iss.kind);
          $("lightbox").classList.add("hidden");
          $("status").textContent = iss.fixedMsg + "，可直接重新生成";
        };
        box.appendChild(b);
      });
      side.appendChild(box);
    });
  }
  // 箭头显隐
  $("lbPrev").style.display = LB_ITEMS.length > 1 ? "block" : "none";
  $("lbNext").style.display = LB_ITEMS.length > 1 ? "block" : "none";
  $("lbInfo").textContent = "滚轮缩放 / 拖拽移动 / ←→ 切换 / Esc 关闭";
  $("lightbox").classList.remove("hidden");
}

function lbMove(dir) {
  if (LB_ITEMS.length < 2) return;
  LB_INDEX = (LB_INDEX + dir + LB_ITEMS.length) % LB_ITEMS.length;
  showLbItem();
}

// ---------- 生成问题检测与一键修复 ----------
function imgSaturation(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        const s = 64;
        c.width = s; c.height = s;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, s, s);
        const d = ctx.getImageData(0, 0, s, s).data;
        let sum = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (mx > 0.05) sum += (mx - mn) / mx;
          n++;
        }
        resolve(sum / Math.max(1, n));
      } catch (e) { resolve(-1); }
    };
    img.onerror = () => resolve(-1);
    img.src = url;
  });
}

async function detectIssues(settings, url) {
  const issues = [];
  if (!settings) return issues;
  const cfg = parseFloat(settings.cfg) || 7;
  const steps = parseInt(settings.steps) || 28;
  const prompt = settings.prompt || "";
  const tagCount = prompt.split(",").filter(t => t.trim()).length;
  // 参数规则
  if (cfg >= 7) issues.push({ kind: "saturation", label: "🎨 颜色过饱和（CFG " + cfg + " 偏高）", fixedMsg: "已降低 CFG 并加入去饱和负面词" });
  if ((settings.negative || "").length > 300) issues.push({ kind: "neglen", label: "⚠ 负面词过长（" + (settings.negative || "").length + " 字符，超出部分会被 CLIP 截断失效）", fixedMsg: "已精简负面词到安全长度" });
  if (tagCount > 25) issues.push({ kind: "chaos", label: "🌪 内容混乱（提示词 " + tagCount + " 项过多）", fixedMsg: "已降 CFG 提 Steps 加构图负面词，提示词建议精简" });
  else if (cfg >= 8) issues.push({ kind: "chaos", label: "🌪 内容混乱（CFG 过高烧图）", fixedMsg: "已降 CFG 提 Steps 加构图负面词" });
  if (steps < 20) issues.push({ kind: "quality", label: "🛠 细节不足（Steps 仅 " + steps + "）", fixedMsg: "已提高 Steps" });
  // 图像饱和度实测（白底头像类图排除，饱和度过高才报）
  const sat = await imgSaturation(url);
  if (sat > 0.62) issues.push({ kind: "saturation", label: "🎨 颜色过饱和（实测饱和度 " + sat.toFixed(2) + "）", fixedMsg: "已降低 CFG 并加入去饱和负面词" });
  // 去重
  const seen = new Set();
  return issues.filter(i => { if (seen.has(i.kind)) return false; seen.add(i.kind); return true; }).slice(0, 3);
}

function applyIssueFix(kind) {
  const curCfg = parseFloat($("cfg").value) || 7;
  const curSteps = parseInt($("steps").value) || 28;
  let neg = $("negative").value.trim();
  const add = (s) => { neg = neg ? neg + ", " + s : s; };
  if (kind === "saturation") {
    $("cfg").value = Math.max(4, Math.round((curCfg - 1.5) * 10) / 10);
    add("(over-saturated colors:1.3), (oversaturation:1.3), (high contrast:1.2), (harsh lighting:1.2)");
  } else if (kind === "chaos") {
    $("cfg").value = Math.max(4.5, Math.round((curCfg - 1) * 10) / 10);
    $("steps").value = Math.max(curSteps, 32);
    add("(cluttered composition:1.3), (melted:1.3), (jumbled features:1.3), (duplicate:1.2), (multiple heads:1.2)");
  } else if (kind === "quality") {
    $("steps").value = Math.max(curSteps, 30);
  } else if (kind === "neglen") {
    // 负面词超长：保留前 300 字符，去掉被截断风险的后半段
    const nv = $("negative").value;
    if (nv.length > 300) $("negative").value = nv.slice(0, 300);
  }
  $("negative").value = neg;
}
$("lbPrev").onclick = () => lbMove(-1);
$("lbNext").onclick = () => lbMove(1);
function applyLbTransform() {
  $("lbImg").style.transform = `translate(${lbX}px, ${lbY}px) scale(${lbScale})`;
}
$("lbClose").onclick = () => $("lightbox").classList.add("hidden");
$("lightbox").addEventListener("click", (e) => {
  if (e.target === $("lightbox")) $("lightbox").classList.add("hidden");
});
$("lbStage").addEventListener("wheel", (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  lbScale = Math.min(12, Math.max(0.2, lbScale * delta));
  applyLbTransform();
}, { passive: false });
$("lbStage").addEventListener("mousedown", (e) => {
  lbDrag = { x: e.clientX - lbX, y: e.clientY - lbY };
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (lbDrag) { lbX = e.clientX - lbDrag.x; lbY = e.clientY - lbDrag.y; applyLbTransform(); }
});
window.addEventListener("mouseup", () => lbDrag = null);
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("lightbox").classList.add("hidden"); $("favPanel").classList.add("hidden"); $("ratePanel").classList.add("hidden"); }
  if (!$("lightbox").classList.contains("hidden")) {
    if (e.key === "ArrowRight") lbMove(1);
    if (e.key === "ArrowLeft") lbMove(-1);
    if (/^[1-5]$/.test(e.key)) {
      const it = LB_ITEMS[LB_INDEX];
      setScore(lbFilename(it), parseInt(e.key, 10), (it && it.settings) || {});
      if (LB_ITEMS.length > 1) lbMove(1);
    }
  }
});
// 触摸滑动切换（手机）
$("lbStage").addEventListener("touchstart", e => { lbTouchX = e.touches[0].clientX; }, { passive: true });
$("lbStage").addEventListener("touchend", e => {
  if (lbTouchX === null) return;
  const dx = e.changedTouches[0].clientX - lbTouchX;
  if (Math.abs(dx) > 60) lbMove(dx < 0 ? 1 : -1);
  lbTouchX = null;
}, { passive: true });

init();
pollTasks();
refreshTriggers();
loadFavs();

// ================= 一致性锁（IPAdapter） =================
let ID_IMAGE = "";

const uploadToInput = async (file) => {
  const fd = new FormData();
  fd.append("file", file);
  return api("/api/upload", { method: "POST", body: fd });
};
const inputUrl = (name) => `/api/image?filename=${encodeURIComponent(name)}&type=input`;

function bindCollapse(headId, bodyId, arrowId) {
  const head = $(headId), body = $(bodyId), arrow = $(arrowId);
  if (!head || !body) return;
  const key = "genui_collapse_" + bodyId;
  const apply = (open) => {
    body.style.display = open ? "" : "none";
    if (arrow) arrow.textContent = open ? "▾" : "▸";
    localStorage.setItem(key, open ? "1" : "0");
  };
  head.onclick = () => apply(body.style.display === "none");
  const saved = localStorage.getItem(key);
  apply(saved === null ? true : saved === "1");
}

function setPreview(imgEl, nameEl, name) {
  if (!name) { imgEl.style.display = "none"; imgEl.removeAttribute("src"); nameEl.textContent = ""; return; }
  imgEl.src = inputUrl(name);
  imgEl.style.display = "block";
  nameEl.textContent = name;
}

// --- 一致性锁（IPAdapter）---
$("idFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  $("idName").textContent = "上传中...";
  const r = await uploadToInput(f);
  if (!r.ok) { $("idName").textContent = "上传失败: " + r.error; return; }
  ID_IMAGE = r.name;
  setPreview($("idPreview"), $("idName"), ID_IMAGE);
  $("idOn").checked = true;
});

bindCollapse("idToggle", "idBody", "idArrow");

