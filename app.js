// app.js — Meus Drinks

import {
  BASE_SPIRITS,
  TECHNIQUES,
  UNITS,
  STATUSES,
  validateDrinkFields,
  validateImportPayload,
  validateRating,
  validateComment,
  validateStatus,
} from "./validation.js";

import {
  createRecord,
  updateRecord,
  deleteRecord,
  listRecords,
  getPhotos,
  getRevisionInfo,
  markBackedUp,
  onRemoteChange,
  DuplicateIdentityError,
  ConcurrencyError,
} from "./db.js";

import {
  buildBackup,
  shareOrDownloadBackup,
  readAndValidateBackupFile,
  prepareRestore,
  performRestore,
} from "./backup.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const spiritLabel = Object.fromEntries(BASE_SPIRITS.map((s) => [s.value, s.label]));
const techniqueLabel = Object.fromEntries(TECHNIQUES.map((t) => [t.value, t.label]));
const statusLabel = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]));

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

let allRecords = [];
let filters = { status: "", spirit: "", search: "" };
let editingRecord = null; // { ...record } currently open in the form, or null for "create"
let pendingPhotoFiles = {}; // { primary?: File|null, secondary?: File|null } — undefined key = untouched
let existingPhotoUrls = {}; // object URLs for the record currently open in the form
let currentRating = null;
let cardObjectUrls = new Map(); // recordId -> {primary?:url, secondary?:url} for list thumbnails
let pendingImportDraft = null; // {drink, analysis} validated but not yet saved

// ---------------------------------------------------------------------
// Static option population
// ---------------------------------------------------------------------

function fillSelect(select, options, { placeholder } = {}) {
  select.textContent = "";
  if (placeholder !== undefined) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    select.appendChild(opt);
  }
  for (const { value, label } of options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }
}

fillSelect($("#f-base-spirit"), BASE_SPIRITS, { placeholder: "Selecione" });
fillSelect($("#filter-spirit"), BASE_SPIRITS, { placeholder: "Todas as bases" });
for (const t of TECHNIQUES) {
  const opt = document.createElement("option");
  opt.value = t.value;
  opt.textContent = t.label;
  $("#f-technique").appendChild(opt);
}
fillSelect($("#f-status"), STATUSES);

// ---------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------

let toastTimer = null;
function showToast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

// ---------------------------------------------------------------------
// Dialog helpers
// ---------------------------------------------------------------------

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}
function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}
$$(".app-dialog").forEach((dialog) => {
  $$("[data-close]", dialog).forEach((btn) =>
    btn.addEventListener("click", () => closeDialog(dialog))
  );
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog); // backdrop click
  });
  // All actions use explicit type="button" handlers; block the implicit
  // form submission that Enter-in-a-text-field would otherwise trigger
  // (method="dialog" would close without saving).
  const form = $(".dialog-form", dialog);
  if (form) form.addEventListener("submit", (event) => event.preventDefault());
});

// ---------------------------------------------------------------------
// Rendering: list + cards
// ---------------------------------------------------------------------

const MEASURABLE_UNITS_TO_ML = { ml: 1, oz: 29.5735 };
const RATIO_COLORS = ["var(--copper)", "var(--olive)", "var(--wine)", "var(--copper-tint)", "var(--olive-deep)"];

function buildPourRatio(container, ingredients) {
  container.textContent = "";
  const measurable = ingredients.filter(
    (i) => i.amount != null && i.unit && MEASURABLE_UNITS_TO_ML[i.unit]
  );
  if (measurable.length < 2) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const totals = measurable.map((i) => i.amount * MEASURABLE_UNITS_TO_ML[i.unit]);
  const sum = totals.reduce((a, b) => a + b, 0) || 1;
  measurable.forEach((ing, i) => {
    const span = document.createElement("span");
    const pct = (totals[i] / sum) * 100;
    span.style.width = `${pct}%`;
    span.style.background = RATIO_COLORS[i % RATIO_COLORS.length];
    span.title = `${ing.name}`;
    container.appendChild(span);
  });
}

function matchesFilters(record) {
  const d = record.import_data;
  if (filters.status && record.status !== filters.status) return false;
  if (filters.spirit && d.base_spirit !== filters.spirit) return false;
  if (filters.search) {
    const q = filters.search.toLocaleLowerCase("pt-BR");
    const haystack = [
      d.name,
      spiritLabel[d.base_spirit] || d.base_spirit,
      ...(d.tags || []),
      ...(d.ingredients || []).map((i) => i.name),
    ]
      .join(" ")
      .toLocaleLowerCase("pt-BR");
    if (!haystack.includes(q)) return false;
  }
  return true;
}

async function renderList() {
  const list = $("#drink-list");
  // revoke previous thumbnail object URLs before re-render
  for (const urls of cardObjectUrls.values()) {
    if (urls.primary) URL.revokeObjectURL(urls.primary);
  }
  cardObjectUrls = new Map();
  list.textContent = "";

  const sorted = [...allRecords].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const filtered = sorted.filter(matchesFilters);

  $("#empty-state").hidden = allRecords.length !== 0;
  $("#no-results").hidden = !(allRecords.length > 0 && filtered.length === 0);

  const template = $("#drink-card-template");
  for (const record of filtered) {
    const node = template.content.firstElementChild.cloneNode(true);
    const d = record.import_data;
    node.dataset.id = record.id;

    $(".drink-card-name", node).textContent = d.name;
    $(".drink-card-spirit", node).textContent = spiritLabel[d.base_spirit] || d.base_spirit;

    const stamp = $(".stamp", node);
    stamp.hidden = false;
    stamp.textContent =
      record.status === "favorite" ? "★ favorito" : record.status === "tried" ? "✓ já fiz" : "quero fazer";
    stamp.classList.add(`stamp-${record.status}`);

    buildPourRatio($(".pour-ratio", node), d.ingredients || []);

    $(".drink-card-rating", node).textContent = record.rating ? "★".repeat(record.rating) : "";
    $(".drink-card-tags", node).textContent = (d.tags || []).join(" · ");

    if (record.has_primary_photo) {
      getPhotos(record.id).then(({ primaryPhoto }) => {
        if (!primaryPhoto) return;
        const url = URL.createObjectURL(primaryPhoto.blob);
        cardObjectUrls.set(record.id, { primary: url });
        const img = $(".drink-card-img", node);
        const placeholder = $(".drink-card-placeholder", node);
        img.src = url;
        img.hidden = false;
        placeholder.hidden = true;
      });
    }

    $(".drink-card-open", node).addEventListener("click", () => openEditForm(record.id));
    list.appendChild(node);
  }
}

async function refreshRecords() {
  allRecords = await listRecords();
  await renderList();
  await refreshBackupBanner();
}

async function refreshBackupBanner() {
  const info = await getRevisionInfo();
  const pending = info.revision > info.backedUpRevision && info.revision > 0;
  $("#backup-pending-banner").hidden = !pending;
  const text = $("#backup-status-text");
  if (info.lastBackupAt) {
    const when = new Date(info.lastBackupAt).toLocaleString("pt-BR");
    text.textContent = pending
      ? `Último backup: ${when}. Há alterações desde então.`
      : `Último backup: ${when}. Tudo salvo.`;
  } else {
    text.textContent = "Você ainda não fez nenhum backup.";
  }
}

// ---------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------

let searchDebounce = null;
$("#search-input").addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    filters.search = e.target.value.trim();
    renderList();
  }, 150);
});
$("#filter-spirit").addEventListener("change", (e) => {
  filters.spirit = e.target.value;
  renderList();
});
$$(".status-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".status-tab").forEach((t) => {
      t.classList.remove("is-active");
      t.setAttribute("aria-selected", "false");
    });
    tab.classList.add("is-active");
    tab.setAttribute("aria-selected", "true");
    filters.status = tab.dataset.status;
    renderList();
  });
});

// ---------------------------------------------------------------------
// Add-choice dialog
// ---------------------------------------------------------------------

const addChoiceDialog = $("#dialog-add-choice");
$("#btn-add").addEventListener("click", () => openDialog(addChoiceDialog));
$("#empty-add").addEventListener("click", () => openDialog(addChoiceDialog));
$("#choice-form").addEventListener("click", () => {
  closeDialog(addChoiceDialog);
  openCreateForm();
});
$("#choice-import").addEventListener("click", () => {
  closeDialog(addChoiceDialog);
  openImportDialog();
});

// ---------------------------------------------------------------------
// Repeat rows: ingredients / instructions
// ---------------------------------------------------------------------

function addIngredientRow(data = {}) {
  const row = document.createElement("div");
  row.className = "repeat-row";

  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "Ingrediente";
  name.maxLength = 80;
  name.value = data.name || "";

  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "0.1";
  amount.placeholder = "qtd";
  amount.className = "row-amount";
  amount.value = data.amount ?? "";

  const unit = document.createElement("select");
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "un.";
  unit.appendChild(noneOpt);
  for (const u of UNITS) {
    const opt = document.createElement("option");
    opt.value = u.value;
    opt.textContent = u.label;
    unit.appendChild(opt);
  }
  unit.value = data.unit || "";

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-row";
  remove.setAttribute("aria-label", "Remover ingrediente");
  remove.textContent = "×";
  remove.addEventListener("click", () => row.remove());

  row.append(name, amount, unit, remove);
  $("#ingredients-list").appendChild(row);
  return row;
}

function addInstructionRow(text = "") {
  const row = document.createElement("div");
  row.className = "repeat-row instruction-row";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Passo";
  input.maxLength = 300;
  input.value = text;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-row";
  remove.setAttribute("aria-label", "Remover passo");
  remove.textContent = "×";
  remove.addEventListener("click", () => row.remove());

  row.append(input, remove);
  $("#instructions-list").appendChild(row);
  return row;
}

$("#add-ingredient").addEventListener("click", () => addIngredientRow());
$("#add-instruction").addEventListener("click", () => addInstructionRow());

function readIngredientRows() {
  return $$("#ingredients-list .repeat-row").map((row) => {
    const [nameInput, amountInput, unitSelect] = row.children;
    return {
      name: nameInput.value,
      amount: amountInput.value === "" ? null : Number(amountInput.value),
      unit: unitSelect.value || null,
      optional: false,
    };
  });
}

function readInstructionRows() {
  return $$("#instructions-list .repeat-row").map((row) => row.children[0].value);
}

// ---------------------------------------------------------------------
// Rating input
// ---------------------------------------------------------------------

function renderRatingInput() {
  const container = $("#rating-input");
  container.textContent = "";
  for (let i = 1; i <= 5; i++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rating-star";
    btn.dataset.value = String(i);
    btn.textContent = "★";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.addEventListener("click", () => {
      currentRating = currentRating === i ? null : i;
      updateRatingDisplay();
    });
    container.appendChild(btn);
  }
  updateRatingDisplay();
}
function updateRatingDisplay() {
  $$("#rating-input .rating-star").forEach((btn) => {
    const v = Number(btn.dataset.value);
    const filled = currentRating != null && v <= currentRating;
    btn.classList.toggle("is-filled", filled);
    btn.setAttribute("aria-checked", String(filled));
  });
}
renderRatingInput();

// ---------------------------------------------------------------------
// Photo handling
// ---------------------------------------------------------------------

async function loadImageSource(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file);
    } catch (_) {
      // fall through to <img> fallback for formats createImageBitmap dislikes
    }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Não foi possível ler a imagem."));
    img.src = url;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1.5 * 1024 * 1024;
const MAX_EDGE = 1440;

async function compressPhoto(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Formato de imagem não suportado (use JPEG, PNG ou WebP).");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("Imagem muito grande.");
  }
  const source = await loadImageSource(file);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  canvas.getContext("2d").drawImage(source, 0, 0, outW, outH);

  let quality = 0.78;
  let blob = await canvasToBlob(canvas, "image/jpeg", quality);
  if (blob && blob.size > MAX_OUTPUT_BYTES) {
    blob = await canvasToBlob(canvas, "image/jpeg", 0.62);
  }
  if (!blob) throw new Error("Não foi possível processar a imagem.");
  return { blob, name: file.name || "foto.jpg", type: "image/jpeg" };
}

function setupPhotoInput(inputId, previewId, slot) {
  const input = $(inputId);
  const preview = $(previewId);
  const img = $("img", preview);
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    pendingPhotoFiles[slot] = file;
    const url = URL.createObjectURL(file);
    img.src = url;
    preview.hidden = false;
  });
  $(`[data-clear-photo="${slot}"]`, preview).addEventListener("click", () => {
    pendingPhotoFiles[slot] = null;
    input.value = "";
    preview.hidden = true;
    img.src = "";
  });
}
setupPhotoInput("#f-photo-primary", "#preview-primary", "primary");
setupPhotoInput("#f-photo-secondary", "#preview-secondary", "secondary");

// ---------------------------------------------------------------------
// Drink form dialog (create / edit)
// ---------------------------------------------------------------------

const drinkFormDialog = $("#dialog-drink-form");

function resetDrinkForm() {
  editingRecord = null;
  pendingPhotoFiles = {};
  for (const url of Object.values(existingPhotoUrls)) URL.revokeObjectURL(url);
  existingPhotoUrls = {};
  currentRating = null;

  $("#drink-form-title").textContent = "Novo drink";
  $("#draft-notice").hidden = true;
  $("#f-name").value = "";
  $("#f-base-spirit").value = "";
  $("#f-technique").value = "";
  $("#f-glassware").value = "";
  $("#f-ice").value = "";
  $("#f-garnish").value = "";
  $("#f-tags").value = "";
  $("#f-source").value = "";
  $("#f-abv").value = "";
  $("#f-status").value = "want_to_try";
  $("#f-comment").value = "";
  $("#ingredients-list").textContent = "";
  $("#instructions-list").textContent = "";
  addIngredientRow();
  addInstructionRow();
  renderRatingInput();
  $("#preview-primary").hidden = true;
  $("#preview-secondary").hidden = true;
  $("#f-photo-primary").value = "";
  $("#f-photo-secondary").value = "";
  $("#form-errors").hidden = true;
  $("#form-errors").textContent = "";
  $("#delete-drink").hidden = true;
}

function showFormErrors(errors, extra) {
  const box = $("#form-errors");
  box.textContent = "";
  const list = document.createElement("ul");
  for (const err of errors) {
    const li = document.createElement("li");
    li.textContent = err;
    list.appendChild(li);
  }
  box.appendChild(list);
  if (extra && extra.duplicate) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "link-button";
    btn.textContent = `Abrir "${extra.duplicate.import_data.name}"`;
    btn.addEventListener("click", () => openEditForm(extra.duplicate.id));
    box.appendChild(btn);
  }
  box.hidden = false;
}

function openCreateForm() {
  resetDrinkForm();
  openDialog(drinkFormDialog);
}

function fillDrinkFieldsFromDrink(drink) {
  $("#f-name").value = drink.name || "";
  $("#f-base-spirit").value = drink.base_spirit || "";
  $("#f-technique").value = drink.technique || "";
  $("#f-glassware").value = drink.glassware || "";
  $("#f-ice").value = drink.ice || "";
  $("#f-garnish").value = drink.garnish || "";
  $("#f-tags").value = (drink.tags || []).join(", ");
  $("#f-source").value = drink.source || "";
  $("#f-abv").value = drink.estimated_abv_percent ?? "";

  $("#ingredients-list").textContent = "";
  (drink.ingredients && drink.ingredients.length ? drink.ingredients : [{}]).forEach((i) =>
    addIngredientRow(i)
  );
  $("#instructions-list").textContent = "";
  (drink.instructions && drink.instructions.length ? drink.instructions : [""]).forEach((s) =>
    addInstructionRow(s)
  );
}

async function openEditForm(id) {
  const record = allRecords.find((r) => r.id === id);
  if (!record) return;
  resetDrinkForm();
  editingRecord = record;
  $("#drink-form-title").textContent = "Editar drink";
  $("#delete-drink").hidden = false;

  fillDrinkFieldsFromDrink(record.import_data);
  $("#f-status").value = record.status;
  $("#f-comment").value = record.comment || "";
  currentRating = record.rating || null;
  renderRatingInput();

  const { primaryPhoto, secondaryPhoto } = await getPhotos(record.id);
  if (primaryPhoto) {
    const url = URL.createObjectURL(primaryPhoto.blob);
    existingPhotoUrls.primary = url;
    $("#preview-primary img").src = url;
    $("#preview-primary").hidden = false;
  }
  if (secondaryPhoto) {
    const url = URL.createObjectURL(secondaryPhoto.blob);
    existingPhotoUrls.secondary = url;
    $("#preview-secondary img").src = url;
    $("#preview-secondary").hidden = false;
  }

  openDialog(drinkFormDialog);
}

$("#save-drink").addEventListener("click", async () => {
  $("#form-errors").hidden = true;

  const drinkInput = {
    name: $("#f-name").value,
    base_spirit: $("#f-base-spirit").value,
    tags: $("#f-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    ingredients: readIngredientRows(),
    technique: $("#f-technique").value || null,
    glassware: $("#f-glassware").value,
    ice: $("#f-ice").value,
    garnish: $("#f-garnish").value,
    instructions: readInstructionRows(),
    source: $("#f-source").value,
    estimated_abv_percent: $("#f-abv").value === "" ? null : $("#f-abv").value,
  };

  const { valid, errors, drink } = validateDrinkFields(drinkInput);
  if (!valid) {
    showFormErrors(errors);
    return;
  }
  const rating = validateRating(currentRating);
  const comment = validateComment($("#f-comment").value);
  const status = validateStatus($("#f-status").value);

  let photosPatch;
  try {
    photosPatch = {};
    if (Object.prototype.hasOwnProperty.call(pendingPhotoFiles, "primary")) {
      photosPatch.primary = pendingPhotoFiles.primary === null ? null : await compressPhoto(pendingPhotoFiles.primary);
    }
    if (Object.prototype.hasOwnProperty.call(pendingPhotoFiles, "secondary")) {
      photosPatch.secondary =
        pendingPhotoFiles.secondary === null ? null : await compressPhoto(pendingPhotoFiles.secondary);
    }
    if (Object.keys(photosPatch).length === 0) photosPatch = undefined;
  } catch (e) {
    showFormErrors([e.message]);
    return;
  }

  try {
    if (editingRecord) {
      const patch = { drink, rating, comment, status };
      if (photosPatch) patch.photos = photosPatch;
      await updateRecord(editingRecord.id, editingRecord.updated_at, patch);
      showToast("Drink atualizado.");
    } else {
      const photosForCreate = {};
      if (photosPatch && photosPatch.primary) photosForCreate.primary = photosPatch.primary;
      if (photosPatch && photosPatch.secondary) photosForCreate.secondary = photosPatch.secondary;
      await createRecord(drink, { rating, comment, status }, photosForCreate);
      showToast("Drink salvo.");
    }
    closeDialog(drinkFormDialog);
    await refreshRecords();
  } catch (e) {
    if (e instanceof DuplicateIdentityError) {
      showFormErrors([e.message], { duplicate: e.existingRecord });
    } else if (e instanceof ConcurrencyError) {
      showFormErrors([e.message]);
    } else {
      showFormErrors([`Erro ao salvar: ${e.message}`]);
    }
  }
});

$("#delete-drink").addEventListener("click", async () => {
  if (!editingRecord) return;
  const ok = window.confirm(`Excluir "${editingRecord.import_data.name}"? Isso não pode ser desfeito.`);
  if (!ok) return;
  try {
    await deleteRecord(editingRecord.id, editingRecord.updated_at);
    showToast("Drink excluído.");
    closeDialog(drinkFormDialog);
    await refreshRecords();
  } catch (e) {
    showFormErrors([e.message]);
  }
});

drinkFormDialog.addEventListener("close", () => {
  for (const url of Object.values(existingPhotoUrls)) URL.revokeObjectURL(url);
  existingPhotoUrls = {};
});

// ---------------------------------------------------------------------
// Import (paste AI-generated JSON) dialog
// ---------------------------------------------------------------------

const importDialog = $("#dialog-import");

const PROMPT_TEMPLATE = `Analise esse drink (link, legenda e/ou print em anexo) e gere APENAS um JSON, sem nenhum texto antes ou depois, neste formato exato:

{
  "schema_version": "1.0.0",
  "drink": {
    "name": "",
    "base_spirit": "rum | gin | vodka | whisky | tequila | cachaca | conhaque | licor | vinho | cerveja | sem_alcool | outro",
    "tags": [],
    "ingredients": [{"name": "", "amount": 0, "unit": "ml | oz | dash | barspoon | piece | to_taste", "optional": false}],
    "technique": "build | stir | shake | blend | muddle | other",
    "glassware": "",
    "ice": "",
    "garnish": "",
    "instructions": [""],
    "source": "",
    "estimated_abv_percent": null
  },
  "analysis": {
    "summary": "",
    "confidence": "high | medium | low",
    "uncertainties": [""]
  }
}

Use null quando não tiver certeza de um valor (não invente quantidade). Liste em "uncertainties" o que foi estimado ou não apareceu no material.`;

$("#import-prompt-template").textContent = PROMPT_TEMPLATE;
$("#copy-prompt").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(PROMPT_TEMPLATE);
    showToast("Instrução copiada.");
  } catch (_) {
    showToast("Não foi possível copiar automaticamente — selecione o texto manualmente.");
  }
});

function openImportDialog() {
  $("#import-json-input").value = "";
  $("#import-errors").hidden = true;
  $("#import-preview").hidden = true;
  $("#import-save").disabled = true;
  pendingImportDraft = null;
  openDialog(importDialog);
}

$("#import-validate").addEventListener("click", () => {
  const raw = $("#import-json-input").value;
  const result = validateImportPayload(raw);
  const errBox = $("#import-errors");
  const previewBox = $("#import-preview");

  if (!result.valid) {
    errBox.textContent = "";
    const list = document.createElement("ul");
    for (const err of result.errors) {
      const li = document.createElement("li");
      li.textContent = err;
      list.appendChild(li);
    }
    errBox.appendChild(list);
    errBox.hidden = false;
    previewBox.hidden = true;
    $("#import-save").disabled = true;
    pendingImportDraft = null;
    return;
  }

  errBox.hidden = true;
  pendingImportDraft = { drink: result.drink, analysis: result.analysis };

  previewBox.textContent = "";
  const title = document.createElement("h3");
  title.textContent = result.drink.name;
  if (result.analysis && result.analysis.confidence) {
    const badge = document.createElement("span");
    badge.className = `confidence-badge confidence-${result.analysis.confidence}`;
    badge.textContent = `confiança ${result.analysis.confidence}`;
    title.appendChild(badge);
  }
  previewBox.appendChild(title);

  const meta = document.createElement("p");
  meta.textContent = `${spiritLabel[result.drink.base_spirit] || result.drink.base_spirit} · ${result.drink.ingredients.length} ingrediente(s) · ${result.drink.instructions.length} passo(s)`;
  previewBox.appendChild(meta);

  if (result.analysis && result.analysis.summary) {
    const summary = document.createElement("p");
    summary.textContent = result.analysis.summary;
    previewBox.appendChild(summary);
  }
  if (result.analysis && result.analysis.uncertainties && result.analysis.uncertainties.length) {
    const uncTitle = document.createElement("p");
    uncTitle.textContent = "Pontos incertos:";
    previewBox.appendChild(uncTitle);
    const uncList = document.createElement("ul");
    for (const u of result.analysis.uncertainties) {
      const li = document.createElement("li");
      li.textContent = u;
      uncList.appendChild(li);
    }
    previewBox.appendChild(uncList);
  }
  previewBox.hidden = false;
  $("#import-save").disabled = false;
});

$("#import-save").addEventListener("click", () => {
  if (!pendingImportDraft) return;
  closeDialog(importDialog);
  resetDrinkForm();
  fillDrinkFieldsFromDrink(pendingImportDraft.drink);

  const notice = $("#draft-notice");
  notice.textContent = "";
  const p1 = document.createElement("p");
  p1.textContent = "Rascunho gerado por IA — confira os valores antes de salvar.";
  notice.appendChild(p1);
  if (pendingImportDraft.analysis && pendingImportDraft.analysis.uncertainties?.length) {
    const p2 = document.createElement("p");
    p2.textContent = `Pontos incertos: ${pendingImportDraft.analysis.uncertainties.join("; ")}`;
    notice.appendChild(p2);
  }
  notice.hidden = false;

  openDialog(drinkFormDialog);
});

// ---------------------------------------------------------------------
// Settings / backup / restore
// ---------------------------------------------------------------------

const settingsDialog = $("#dialog-settings");
$("#btn-settings").addEventListener("click", async () => {
  await refreshBackupBanner();
  openDialog(settingsDialog);
});
$("#banner-backup-now").addEventListener("click", () => openDialog(settingsDialog));

let pendingBackupRevision = null;
const backupConfirmDialog = $("#dialog-backup-confirm");

$("#do-backup").addEventListener("click", async () => {
  const { blob, filename, revision } = await buildBackup();
  const result = await shareOrDownloadBackup(blob, filename);
  pendingBackupRevision = revision;
  $("#backup-confirm-text").textContent =
    result.method === "share"
      ? "Confirme que você concluiu o salvamento no compartilhamento (Arquivos, Drive, e-mail…)."
      : "O download começou. Confirme que o arquivo foi salvo em um lugar seguro.";
  openDialog(backupConfirmDialog);
});

$("#confirm-backup-saved").addEventListener("click", async () => {
  if (pendingBackupRevision != null) {
    await markBackedUp(pendingBackupRevision);
    pendingBackupRevision = null;
    await refreshBackupBanner();
    showToast("Backup confirmado.");
  }
  closeDialog(backupConfirmDialog);
});

const restoreConflictDialog = $("#dialog-restore-conflicts");
let pendingRestoreItems = null;
let pendingRestoreDuplicates = null;

$("#restore-file-input").addEventListener("change", async () => {
  const file = $("#restore-file-input").files[0];
  const status = $("#restore-status");
  status.textContent = "";
  if (!file) return;

  const { valid, errors, parsed } = await readAndValidateBackupFile(file);
  if (!valid) {
    status.textContent = `Backup inválido: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} outros)` : ""}`;
    $("#restore-file-input").value = "";
    return;
  }

  status.textContent = "Lendo backup…";
  const { items, duplicates } = await prepareRestore(parsed);
  pendingRestoreItems = items;
  pendingRestoreDuplicates = duplicates;
  $("#restore-file-input").value = "";

  if (duplicates.length === 0) {
    const counts = await performRestore(items, {});
    status.textContent = `Restaurado: ${counts.added} adicionados.`;
    await refreshRecords();
    return;
  }

  const list = $("#conflict-list");
  list.textContent = "";
  for (const dup of duplicates) {
    const row = document.createElement("div");
    row.className = "conflict-row";
    const label = document.createElement("span");
    label.textContent = dup.incomingName;
    const select = document.createElement("select");
    select.dataset.identity = dup.identity;
    const keepOpt = document.createElement("option");
    keepOpt.value = "keep";
    keepOpt.textContent = "Manter o local";
    const replaceOpt = document.createElement("option");
    replaceOpt.value = "replace";
    replaceOpt.textContent = "Substituir pelo backup";
    select.append(keepOpt, replaceOpt);
    row.append(label, select);
    list.appendChild(row);
  }
  status.textContent = `${duplicates.length} drink(s) já existem — escolha o que fazer.`;
  openDialog(restoreConflictDialog);
});

$("#confirm-restore").addEventListener("click", async () => {
  if (!pendingRestoreItems) return;
  const resolutions = {};
  $$("#conflict-list select").forEach((select) => {
    resolutions[select.dataset.identity] = select.value;
  });
  const counts = await performRestore(pendingRestoreItems, resolutions);
  pendingRestoreItems = null;
  pendingRestoreDuplicates = null;
  closeDialog(restoreConflictDialog);
  $("#restore-status").textContent = `Restaurado: ${counts.added} adicionados, ${counts.replaced} substituídos, ${counts.kept} mantidos.`;
  await refreshRecords();
});

// ---------------------------------------------------------------------
// Cross-tab sync
// ---------------------------------------------------------------------

onRemoteChange(() => {
  refreshRecords();
});

// ---------------------------------------------------------------------
// Persistent storage (best-effort)
// ---------------------------------------------------------------------

if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

// ---------------------------------------------------------------------
// Service worker registration + update flow
// ---------------------------------------------------------------------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("./service-worker.js")
      .then((registration) => {
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              $("#update-banner").hidden = false;
              $("#update-now").onclick = () => {
                installing.postMessage({ type: "SKIP_WAITING" });
              };
            }
          });
        });
      })
      .catch(() => {
        // Offline install support degrades gracefully without a worker.
      });

    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

refreshRecords();
