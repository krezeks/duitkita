"use strict";
/* DuitKita: local-first finance notes. All data lives in one localStorage key. No network, ever. */
const STORAGE_KEY = "duitkita-v1";
const CATS_OUT = ["Makan", "Kopi", "Transport", "Belanja", "Jajan", "Tagihan", "Tabungan", "Lainnya"];
const CATS_IN = ["Gaji", "Transfer", "Usaha", "Lainnya"];
const GOAL_COLORS = ["#FFB25E", "#3ECF8E", "#4EA8FF", "#B18CFF", "#FF8FA3"];
const MONTH_FMT = new Intl.DateTimeFormat("id-ID", { month: "long", year: "numeric" });
const DAY_FMT = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const NUM_FMT = new Intl.NumberFormat("id-ID");

let state = load();
let cursor = firstOfMonth(new Date());
let txType = "out";
let txCat = CATS_OUT[0];
let historyFilter = "all";

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { txs: [], goals: [] };
    const data = JSON.parse(raw);
    if (!Array.isArray(data.txs) || !Array.isArray(data.goals)) return { txs: [], goals: [] };
    return sanitizeState(data).state;
  } catch (e) {
    return { txs: [], goals: [] };
  }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- import hygiene ----------
   Data dari file backup (atau penyimpanan lama) tidak pernah dipercaya mentah:
   setiap entri dibangun ulang kolom demi kolom. id yang tidak aman polanya
   diganti id baru, nominal harus angka positif, jenis harus in/out, tanggal
   harus YYYY-MM-DD. Entri yang gagal dibuang dan dihitung. */
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_OK = /^\d{4}-\d{2}-\d{2}$/;
function cleanStr(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
function sanitizeGoal(g, usedIds) {
  if (!g || typeof g !== "object") return null;
  const target = Number(g.target);
  const name = cleanStr(g.name, 60).trim();
  if (!name || !Number.isFinite(target) || target <= 0) return null;
  let id = (typeof g.id === "string" && ID_OK.test(g.id)) ? g.id : uid();
  if (usedIds.has(id)) id = uid();
  usedIds.add(id);
  return {
    id,
    name,
    target: Math.round(target),
    date: (typeof g.date === "string" && DATE_OK.test(g.date)) ? g.date : ""
  };
}
function sanitizeTx(t, idMap, goalIds, usedIds) {
  if (!t || typeof t !== "object") return null;
  if (t.type !== "in" && t.type !== "out") return null;
  const amount = Number(t.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (typeof t.date !== "string" || !DATE_OK.test(t.date)) return null;
  let id = (typeof t.id === "string" && ID_OK.test(t.id)) ? t.id : uid();
  if (usedIds.has(id)) id = uid();
  usedIds.add(id);
  const tx = {
    id,
    type: t.type,
    amount: Math.round(amount),
    cat: cleanStr(t.cat, 40) || "Lainnya",
    wallet: cleanStr(t.wallet, 40) || "Tunai",
    note: cleanStr(t.note, 120),
    date: t.date,
    created: Number.isFinite(Number(t.created)) ? Number(t.created) : Date.now()
  };
  if (typeof t.goalId === "string") {
    const mapped = idMap.get(t.goalId) || t.goalId;
    if (goalIds.has(mapped)) tx.goalId = mapped;
  }
  return tx;
}
function sanitizeState(data) {
  const idMap = new Map();
  const goalIds = new Set();
  const usedGoalIds = new Set();
  const goals = [];
  let dropped = 0;
  (Array.isArray(data.goals) ? data.goals : []).forEach(g => {
    const clean = sanitizeGoal(g, usedGoalIds);
    if (!clean) { dropped++; return; }
    if (g && typeof g.id === "string") idMap.set(g.id, clean.id);
    goalIds.add(clean.id);
    goals.push(clean);
  });
  const usedTxIds = new Set();
  const txs = [];
  (Array.isArray(data.txs) ? data.txs : []).forEach(t => {
    const clean = sanitizeTx(t, idMap, goalIds, usedTxIds);
    if (!clean) { dropped++; return; }
    txs.push(clean);
  });
  return { state: { txs, goals }, dropped };
}
function rp(n) {
  const sign = n < 0 ? "-" : "";
  return sign + "Rp" + NUM_FMT.format(Math.abs(Math.round(n)));
}
function firstOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function sameMonth(d, ref) {
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
}
function dateKey(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function monthTxs() {
  return state.txs.filter(t => sameMonth(new Date(t.date + "T12:00:00"), cursor));
}
function goalSaved(goalId) {
  return state.txs
    .filter(t => t.goalId === goalId)
    .reduce((sum, t) => sum + t.amount, 0);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2400);
}

/* ---------- rendering ---------- */
function render() {
  document.getElementById("monthLabel").textContent = MONTH_FMT.format(cursor);
  renderHome();
  renderHistory();
  renderGoals();
  renderAnalysis();
}

function renderHome() {
  const txs = monthTxs();
  const income = txs.filter(t => t.type === "in").reduce((s, t) => s + t.amount, 0);
  const expense = txs.filter(t => t.type === "out").reduce((s, t) => s + t.amount, 0);
  document.getElementById("heroExpense").textContent = rp(expense);
  document.getElementById("heroIncome").textContent = rp(income);
  document.getElementById("heroNet").textContent = rp(income - expense);

  const todayKey = dateKey(new Date());
  const todayOut = state.txs
    .filter(t => t.type === "out" && t.date === todayKey)
    .reduce((s, t) => s + t.amount, 0);
  document.getElementById("statToday").textContent = rp(todayOut);

  const now = new Date();
  const daysDivisor = sameMonth(now, cursor)
    ? now.getDate()
    : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  document.getElementById("statAvg").textContent = rp(daysDivisor ? expense / daysDivisor : 0);

  const homeGoals = document.getElementById("homeGoals");
  if (state.goals.length === 0) {
    homeGoals.innerHTML = emptyBox("Belum ada target", "Buat target pertama di tab Target, mis. dana darurat atau liburan.");
  } else {
    homeGoals.innerHTML = state.goals.slice(0, 2).map(goalCard).join("");
    bindGoalButtons(homeGoals);
  }

  const recent = document.getElementById("homeRecent");
  const last = [...state.txs].sort((a, b) => b.created - a.created).slice(0, 5);
  if (last.length === 0) {
    recent.innerHTML = emptyBox("Belum ada catatan", "Ketuk tombol + di bawah untuk mencatat transaksi pertamamu.");
  } else {
    recent.innerHTML = last.map(txRow).join("");
    bindTxRows(recent);
  }
}

function emptyBox(title, text) {
  return '<div class="empty"><p>' + esc(title) + "</p><span>" + esc(text) + "</span></div>";
}

function goalCard(g, idx) {
  const saved = goalSaved(g.id);
  const pct = g.target > 0 ? Math.min(100, Math.round(saved / g.target * 100)) : 0;
  const color = GOAL_COLORS[idx % GOAL_COLORS.length];
  const dateTxt = g.date ? " · target " + new Date(g.date + "T12:00:00").toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "";
  return '<article class="card goal">' +
    '<div class="goal-top"><p class="goal-name">' + esc(g.name) + '</p><span class="goal-pct">' + pct + '%</span></div>' +
    '<p class="goal-meta">' + rp(saved) + " dari " + rp(g.target) + dateTxt + "</p>" +
    '<div class="goal-bar"><div class="goal-fill" style="width:' + pct + "%;background:" + color + '"></div></div>' +
    '<div class="goal-actions">' +
      '<button type="button" class="mini-btn" data-fund="' + g.id + '">+ Isi target</button>' +
      '<button type="button" class="mini-btn danger" data-delgoal="' + g.id + '">Hapus</button>' +
    "</div></article>";
}

function bindGoalButtons(root) {
  root.querySelectorAll("[data-fund]").forEach(btn => {
    btn.addEventListener("click", () => openTx({ type: "out", cat: "Tabungan", goalId: btn.dataset.fund }));
  });
  root.querySelectorAll("[data-delgoal]").forEach(btn => {
    btn.addEventListener("click", () => {
      const g = state.goals.find(x => x.id === btn.dataset.delgoal);
      if (!g) return;
      if (!confirm('Hapus target "' + g.name + '"? Catatan pengisiannya tetap ada di riwayat, hanya tidak terhubung ke target lagi.')) return;
      state.txs.forEach(t => { if (t.goalId === g.id) delete t.goalId; });
      state.goals = state.goals.filter(x => x.id !== g.id);
      save(); render(); toast("Target dihapus");
    });
  });
}

function txRow(t) {
  const sign = t.type === "in" ? "+" : "-";
  const note = t.note ? t.note : t.cat;
  const meta = t.cat + " · " + t.wallet;
  return '<button type="button" class="tx" data-tx="' + t.id + '">' +
    '<span class="tx-main"><span class="tx-note">' + esc(note) + '</span>' +
    '<span class="tx-meta" style="display:block">' + esc(meta) + "</span></span>" +
    '<span class="tx-amount ' + t.type + '">' + sign + rp(t.amount) + "</span></button>";
}

function bindTxRows(root) {
  root.querySelectorAll("[data-tx]").forEach(row => {
    row.addEventListener("click", () => {
      const t = state.txs.find(x => x.id === row.dataset.tx);
      if (!t) return;
      const label = (t.note || t.cat) + " " + (t.type === "in" ? "+" : "-") + rp(t.amount);
      if (!confirm("Hapus catatan ini?\n" + label)) return;
      state.txs = state.txs.filter(x => x.id !== t.id);
      save(); render(); toast("Catatan dihapus");
    });
  });
}

function renderHistory() {
  const list = document.getElementById("historyList");
  let txs = monthTxs().sort((a, b) => (a.date < b.date ? 1 : -1) || (b.created - a.created));
  if (historyFilter !== "all") txs = txs.filter(t => t.type === historyFilter);
  if (txs.length === 0) {
    list.innerHTML = emptyBox("Tidak ada catatan di bulan ini", "Geser bulan di atas, atau ketuk + untuk mencatat.");
    return;
  }
  const groups = new Map();
  txs.forEach(t => {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  });
  let html = "";
  groups.forEach((items, date) => {
    const total = items.reduce((s, t) => s + (t.type === "in" ? t.amount : -t.amount), 0);
    const label = DAY_FMT.format(new Date(date + "T12:00:00"));
    html += '<p class="tx-group-label"><span>' + esc(label) + "</span><span>" + (total < 0 ? "" : "+") + rp(total) + "</span></p>";
    html += items.map(txRow).join("");
  });
  list.innerHTML = html;
  bindTxRows(list);
}

function renderGoals() {
  const list = document.getElementById("goalList");
  if (state.goals.length === 0) {
    list.innerHTML = emptyBox("Belum ada target tabungan", "Target bikin nabung terasa nyata. Buat satu, isi sedikit demi sedikit lewat kategori Tabungan.");
    return;
  }
  list.innerHTML = state.goals.map(goalCard).join("");
  bindGoalButtons(list);
}

function renderAnalysis() {
  const txs = monthTxs().filter(t => t.type === "out");
  document.getElementById("catBars").innerHTML = bars(txs, t => t.cat, "Belum ada pengeluaran bulan ini.");
  document.getElementById("walletBars").innerHTML = bars(txs, t => t.wallet, "Belum ada pengeluaran bulan ini.");
}
function bars(txs, keyFn, emptyMsg) {
  if (txs.length === 0) return emptyBox("Kosong", emptyMsg);
  const sums = new Map();
  txs.forEach(t => sums.set(keyFn(t), (sums.get(keyFn(t)) || 0) + t.amount));
  const rows = [...sums.entries()].sort((a, b) => b[1] - a[1]);
  const max = rows[0][1];
  return rows.map(([name, val]) =>
    '<div class="bar-row"><div class="bar-head"><span class="bar-name">' + esc(name) +
    '</span><span class="bar-val">' + rp(val) + '</span></div>' +
    '<div class="bar-track"><div class="bar-fill" style="width:' + Math.round(val / max * 100) + '%"></div></div></div>'
  ).join("");
}

/* ---------- navigation ---------- */
function goto(view) {
  ["home", "history", "goals", "analysis"].forEach(v => {
    document.getElementById("view-" + v).hidden = v !== view;
  });
  document.querySelectorAll(".tab").forEach(tab => {
    tab.classList.toggle("is-active", tab.dataset.goto === view);
  });
  window.scrollTo({ top: 0 });
}
document.querySelectorAll("[data-goto]").forEach(el => {
  el.addEventListener("click", () => goto(el.dataset.goto));
});
document.getElementById("prevMonth").addEventListener("click", () => {
  cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); render();
});
document.getElementById("nextMonth").addEventListener("click", () => {
  cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); render();
});
document.querySelectorAll("[data-filter]").forEach(chip => {
  chip.addEventListener("click", () => {
    historyFilter = chip.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(c => c.classList.toggle("is-active", c === chip));
    renderHistory();
  });
});

/* ---------- sheets ---------- */
let lastFocused = null;
function openSheet(id) {
  const wrap = document.getElementById(id);
  lastFocused = document.activeElement;
  wrap.hidden = false;
  const first = wrap.querySelector("input, select") || wrap.querySelector("button");
  if (first) first.focus();
}
function closeSheet(id) {
  const wrap = document.getElementById(id);
  if (wrap.hidden) return;
  wrap.hidden = true;
  if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  lastFocused = null;
}
document.querySelectorAll("[data-close]").forEach(btn => {
  btn.addEventListener("click", () => {
    closeSheet("txBackdrop"); closeSheet("goalBackdrop");
  });
});
["txBackdrop", "goalBackdrop"].forEach(id => {
  document.getElementById(id).addEventListener("click", e => {
    if (e.target.id === id) closeSheet(id);
  });
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { closeSheet("txBackdrop"); closeSheet("goalBackdrop"); return; }
  if (e.key !== "Tab") return;
  const open = ["txBackdrop", "goalBackdrop"]
    .map(i => document.getElementById(i))
    .find(w => !w.hidden);
  if (!open) return;
  const items = [...open.querySelectorAll("button, input, select, a[href]")]
    .filter(el => !el.disabled && el.offsetParent !== null);
  if (items.length === 0) return;
  const firstEl = items[0], lastEl = items[items.length - 1];
  if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
  else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
});

/* amount inputs: digits only, grouped while typing */
function bindAmountInput(input) {
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, 13);
    input.value = digits ? NUM_FMT.format(parseInt(digits, 10)) : "";
  });
}
function amountValue(input) {
  const digits = input.value.replace(/\D/g, "");
  return digits ? parseInt(digits, 10) : 0;
}
bindAmountInput(document.getElementById("txAmount"));
bindAmountInput(document.getElementById("goalTarget"));

/* ---------- transaction form ---------- */
function renderTxCats() {
  const cats = txType === "out" ? CATS_OUT : CATS_IN;
  if (!cats.includes(txCat)) txCat = cats[0];
  document.getElementById("txCats").innerHTML = cats.map(c =>
    '<button type="button" class="chip' + (c === txCat ? " is-active" : "") + '" data-cat="' + c + '">' + c + "</button>"
  ).join("");
  document.querySelectorAll("#txCats [data-cat]").forEach(chip => {
    chip.addEventListener("click", () => { txCat = chip.dataset.cat; renderTxCats(); syncGoalPick(); });
  });
}
function syncGoalPick() {
  const wrap = document.getElementById("goalPickWrap");
  const show = txType === "out" && txCat === "Tabungan";
  wrap.hidden = !show;
  if (show) {
    const sel = document.getElementById("txGoal");
    sel.innerHTML = state.goals.map(g => '<option value="' + g.id + '">' + esc(g.name) + "</option>").join("");
  }
}
function setTxType(type) {
  txType = type;
  document.getElementById("segOut").classList.toggle("is-active", type === "out");
  document.getElementById("segIn").classList.toggle("is-active", type === "in");
  renderTxCats(); syncGoalPick();
}
document.getElementById("segOut").addEventListener("click", () => setTxType("out"));
document.getElementById("segIn").addEventListener("click", () => setTxType("in"));

function openTx(preset) {
  preset = preset || {};
  document.getElementById("txError").hidden = true;
  document.getElementById("txAmount").value = "";
  document.getElementById("txNote").value = "";
  document.getElementById("txDate").value = dateKey(new Date());
  setTxType(preset.type || "out");
  if (preset.cat) { txCat = preset.cat; renderTxCats(); syncGoalPick(); }
  if (preset.goalId) document.getElementById("txGoal").value = preset.goalId;
  openSheet("txBackdrop");
  setTimeout(() => document.getElementById("txAmount").focus(), 60);
}
document.getElementById("fabAdd").addEventListener("click", () => openTx());

document.getElementById("txSave").addEventListener("click", () => {
  const err = document.getElementById("txError");
  const amount = amountValue(document.getElementById("txAmount"));
  const date = document.getElementById("txDate").value;
  const fail = msg => { err.textContent = msg; err.hidden = false; };
  if (!amount) return fail("Nominalnya masih kosong.");
  if (!date) return fail("Tanggalnya belum dipilih.");
  const tx = {
    id: uid(),
    type: txType,
    amount: amount,
    cat: txCat,
    wallet: document.getElementById("txWallet").value,
    note: document.getElementById("txNote").value.trim(),
    date: date,
    created: Date.now()
  };
  if (txType === "out" && txCat === "Tabungan") {
    if (state.goals.length === 0) return fail("Belum ada target. Buat target dulu di tab Target.");
    tx.goalId = document.getElementById("txGoal").value;
  }
  state.txs.push(tx);
  cursor = firstOfMonth(new Date(date + "T12:00:00"));
  save(); render(); closeSheet("txBackdrop");
  toast("Tersimpan");
});

/* ---------- goal form ---------- */
document.getElementById("addGoalBtn").addEventListener("click", () => {
  document.getElementById("goalError").hidden = true;
  document.getElementById("goalName").value = "";
  document.getElementById("goalTarget").value = "";
  document.getElementById("goalDate").value = "";
  openSheet("goalBackdrop");
  setTimeout(() => document.getElementById("goalName").focus(), 60);
});
document.getElementById("goalSave").addEventListener("click", () => {
  const err = document.getElementById("goalError");
  const name = document.getElementById("goalName").value.trim();
  const target = amountValue(document.getElementById("goalTarget"));
  const fail = msg => { err.textContent = msg; err.hidden = false; };
  if (!name) return fail("Nama targetnya masih kosong.");
  if (!target) return fail("Jumlah targetnya masih kosong.");
  state.goals.push({ id: uid(), name: name, target: target, date: document.getElementById("goalDate").value || null });
  save(); render(); closeSheet("goalBackdrop");
  toast("Target dibuat");
});

/* ---------- data: export, import, wipe ---------- */
function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
document.getElementById("exportCsv").addEventListener("click", () => {
  const rows = [["tanggal", "catatan", "kategori", "sumber", "jenis", "nominal"]];
  [...state.txs].sort((a, b) => a.created - b.created).forEach(t => {
    rows.push([t.date, t.note || "", t.cat, t.wallet, t.type === "in" ? "masuk" : "keluar", t.amount]);
  });
  const cell = c => {
    let s = String(c);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const csv = rows.map(r => r.map(cell).join(",")).join("\n");
  download("duitkita-transaksi.csv", csv, "text/csv");
  toast("CSV diunduh");
});
document.getElementById("exportJson").addEventListener("click", () => {
  download("duitkita-backup.json", JSON.stringify(state, null, 2), "application/json");
  toast("Backup JSON diunduh");
});
document.getElementById("importFile").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.txs) || !Array.isArray(data.goals)) throw new Error("shape");
      if (!confirm("Import akan mengganti semua data saat ini. Lanjut?")) return;
      const clean = sanitizeState(data);
      state = clean.state;
      save(); render();
      toast(clean.dropped > 0
        ? "Data diimpor, " + clean.dropped + " entri tidak valid dibuang"
        : "Data diimpor");
    } catch (err) {
      alert("File backup tidak valid.");
    }
  };
  reader.readAsText(file);
  e.target.value = "";
});
document.getElementById("wipeData").addEventListener("click", () => {
  if (!confirm("Hapus SEMUA data DuitKita di perangkat ini? Tindakan ini tidak bisa dibatalkan.")) return;
  state = { txs: [], goals: [] };
  save(); render(); toast("Semua data dihapus");
});

render();
