// validation.js
// Single source of truth for the drink data contract. Used by app.js (manual
// form + AI-JSON import) and by tests. Keep this module dependency-free.

export const SCHEMA_VERSION = "1.0.0";
export const BACKUP_VERSION = "1.0.0";

export const BASE_SPIRITS = [
  { value: "rum", label: "Rum" },
  { value: "gin", label: "Gin" },
  { value: "vodka", label: "Vodka" },
  { value: "whisky", label: "Whisky" },
  { value: "tequila", label: "Tequila" },
  { value: "mezcal", label: "Mezcal" },
  { value: "cachaca", label: "Cachaça" },
  { value: "pisco", label: "Pisco" },
  { value: "conhaque", label: "Conhaque / Brandy" },
  { value: "licor", label: "Licor" },
  { value: "vinho", label: "Vinho" },
  { value: "cerveja", label: "Cerveja" },
  { value: "sem_alcool", label: "Sem álcool" },
  { value: "outro", label: "Outro" },
];
export const BASE_SPIRIT_VALUES = new Set(BASE_SPIRITS.map((s) => s.value));

export const TECHNIQUES = [
  { value: "build", label: "Montado direto no copo" },
  { value: "stir", label: "Mexido" },
  { value: "shake", label: "Batido na coqueteleira" },
  { value: "blend", label: "Liquidificado" },
  { value: "muddle", label: "Amassado (muddle)" },
  { value: "other", label: "Outro" },
];
export const TECHNIQUE_VALUES = new Set(TECHNIQUES.map((t) => t.value));

export const UNITS = [
  { value: "ml", label: "ml" },
  { value: "oz", label: "oz" },
  { value: "dash", label: "dash" },
  { value: "barspoon", label: "colher de bar" },
  { value: "piece", label: "unidade" },
  { value: "to_taste", label: "a gosto" },
];
export const UNIT_VALUES = new Set(UNITS.map((u) => u.value));

export const STATUSES = [
  { value: "want_to_try", label: "Quero fazer" },
  { value: "tried", label: "Já fiz" },
  { value: "favorite", label: "Favorito" },
];
export const STATUS_VALUES = new Set(STATUSES.map((s) => s.value));

export const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);

export const LIMITS = {
  NAME_MAX: 160,
  TAG_MAX: 30,
  TAGS_MAX: 10,
  INGREDIENTS_MIN: 1,
  INGREDIENTS_MAX: 30,
  INGREDIENT_NAME_MAX: 80,
  INSTRUCTIONS_MIN: 1,
  INSTRUCTIONS_MAX: 20,
  INSTRUCTION_MAX: 300,
  GLASSWARE_MAX: 60,
  ICE_MAX: 60,
  GARNISH_MAX: 120,
  SOURCE_MAX: 500,
  COMMENT_MAX: 4000,
  SUMMARY_MAX: 500,
  UNCERTAINTY_MAX: 200,
  UNCERTAINTIES_MAX: 10,
  PASTE_JSON_MAX_CHARS: 20000,
  BULK_PASTE_JSON_MAX_CHARS: 200000,
  BULK_IMPORT_MAX_ITEMS: 50,
};

// ---------- normalization helpers ----------

export function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

function normalizeForIdentity(value) {
  return normalizeText(value).toLocaleLowerCase("pt-BR");
}

/** Stable duplicate identity for a drink record: [name, base_spirit, source]. */
export function computeIdentity({ name, base_spirit, source }) {
  const tuple = [
    normalizeForIdentity(name),
    normalizeForIdentity(base_spirit || ""),
    normalizeForIdentity(source || ""),
  ];
  return JSON.stringify(tuple);
}

// ---------- low level field validators ----------

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function pushError(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function validateName(value, path, errors) {
  const name = normalizeText(value);
  if (!name) {
    pushError(errors, path, "obrigatório");
    return null;
  }
  if (name.length > LIMITS.NAME_MAX) {
    pushError(errors, path, `no máximo ${LIMITS.NAME_MAX} caracteres`);
    return null;
  }
  return name;
}

function validateBaseSpirit(value, path, errors) {
  const v = normalizeText(value).toLowerCase();
  if (!v) {
    pushError(errors, path, "obrigatório");
    return null;
  }
  if (!BASE_SPIRIT_VALUES.has(v)) {
    pushError(errors, path, `valor inválido: ${JSON.stringify(value)}`);
    return null;
  }
  return v;
}

function validateTags(value, path, errors) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    pushError(errors, path, "deve ser uma lista de strings");
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const [i, raw] of value.entries()) {
    const tag = normalizeText(raw).toLowerCase();
    if (!tag) continue;
    if (tag.length > LIMITS.TAG_MAX) {
      pushError(errors, `${path}[${i}]`, `no máximo ${LIMITS.TAG_MAX} caracteres`);
      continue;
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  if (out.length > LIMITS.TAGS_MAX) {
    pushError(errors, path, `no máximo ${LIMITS.TAGS_MAX} tags`);
    return out.slice(0, LIMITS.TAGS_MAX);
  }
  return out;
}

function validateIngredients(value, path, errors) {
  if (!Array.isArray(value)) {
    pushError(errors, path, "obrigatório: lista de ingredientes");
    return [];
  }
  if (value.length < LIMITS.INGREDIENTS_MIN) {
    pushError(errors, path, "precisa de ao menos 1 ingrediente");
  }
  if (value.length > LIMITS.INGREDIENTS_MAX) {
    pushError(errors, path, `no máximo ${LIMITS.INGREDIENTS_MAX} ingredientes`);
  }
  const out = [];
  const seenNames = new Set();
  value.slice(0, LIMITS.INGREDIENTS_MAX).forEach((raw, i) => {
    const p = `${path}[${i}]`;
    if (!raw || typeof raw !== "object") {
      pushError(errors, p, "deve ser um objeto");
      return;
    }
    const name = normalizeText(raw.name);
    if (!name) {
      pushError(errors, `${p}.name`, "obrigatório");
      return;
    }
    if (name.length > LIMITS.INGREDIENT_NAME_MAX) {
      pushError(errors, `${p}.name`, `no máximo ${LIMITS.INGREDIENT_NAME_MAX} caracteres`);
      return;
    }
    const key = normalizeForIdentity(name);
    if (seenNames.has(key)) {
      pushError(errors, `${p}.name`, "ingrediente duplicado");
      return;
    }
    seenNames.add(key);

    let amount = null;
    if (raw.amount !== null && raw.amount !== undefined && raw.amount !== "") {
      const n = typeof raw.amount === "string" ? Number(raw.amount) : raw.amount;
      if (!isFiniteNumber(n) || n < 0) {
        pushError(errors, `${p}.amount`, "deve ser um número não-negativo ou nulo");
      } else {
        amount = n;
      }
    }

    let unit = null;
    if (raw.unit !== null && raw.unit !== undefined && raw.unit !== "") {
      const u = normalizeText(raw.unit).toLowerCase();
      if (!UNIT_VALUES.has(u)) {
        pushError(errors, `${p}.unit`, `valor inválido: ${JSON.stringify(raw.unit)}`);
      } else {
        unit = u;
      }
    }

    const optional = raw.optional === true;
    out.push({ name, amount, unit, optional });
  });
  return out;
}

function validateInstructions(value, path, errors) {
  if (!Array.isArray(value)) {
    pushError(errors, path, "obrigatório: lista de passos");
    return [];
  }
  if (value.length < LIMITS.INSTRUCTIONS_MIN) {
    pushError(errors, path, "precisa de ao menos 1 passo");
  }
  if (value.length > LIMITS.INSTRUCTIONS_MAX) {
    pushError(errors, path, `no máximo ${LIMITS.INSTRUCTIONS_MAX} passos`);
  }
  const out = [];
  value.slice(0, LIMITS.INSTRUCTIONS_MAX).forEach((raw, i) => {
    const step = normalizeText(raw);
    if (!step) {
      pushError(errors, `${path}[${i}]`, "passo vazio");
      return;
    }
    if (step.length > LIMITS.INSTRUCTION_MAX) {
      pushError(errors, `${path}[${i}]`, `no máximo ${LIMITS.INSTRUCTION_MAX} caracteres`);
      return;
    }
    out.push(step);
  });
  return out;
}

function validateOptionalShortText(value, path, max, errors) {
  if (value === undefined || value === null || value === "") return null;
  const text = normalizeText(value);
  if (!text) return null;
  if (text.length > max) {
    pushError(errors, path, `no máximo ${max} caracteres`);
    return text.slice(0, max);
  }
  return text;
}

function validateTechnique(value, path, errors) {
  if (value === undefined || value === null || value === "") return null;
  const v = normalizeText(value).toLowerCase();
  if (!TECHNIQUE_VALUES.has(v)) {
    pushError(errors, path, `valor inválido: ${JSON.stringify(value)}`);
    return null;
  }
  return v;
}

function validateSource(value, path, errors) {
  if (value === undefined || value === null || value === "") return null;
  const text = normalizeText(value);
  if (text.length > LIMITS.SOURCE_MAX) {
    pushError(errors, path, `no máximo ${LIMITS.SOURCE_MAX} caracteres`);
    return null;
  }
  // Loose check: must look like a URL if it's meant to be one, but we accept
  // free text too (e.g. "menu do bar X") since not every source is a link.
  return text;
}

function validateAbv(value, path, errors) {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!isFiniteNumber(n) || n < 0 || n > 100) {
    pushError(errors, path, "deve ser um número entre 0 e 100, ou nulo");
    return null;
  }
  return n;
}

/**
 * Validates the core "drink" fields shared by the manual form and the AI
 * import contract. Returns { valid, errors, drink }.
 */
export function validateDrinkFields(input) {
  const errors = [];
  if (!input || typeof input !== "object") {
    return { valid: false, errors: ["drink: objeto ausente ou inválido"], drink: null };
  }
  const name = validateName(input.name, "name", errors);
  const base_spirit = validateBaseSpirit(input.base_spirit, "base_spirit", errors);
  const tags = validateTags(input.tags, "tags", errors);
  const ingredients = validateIngredients(input.ingredients, "ingredients", errors);
  const technique = validateTechnique(input.technique, "technique", errors);
  const glassware = validateOptionalShortText(input.glassware, "glassware", LIMITS.GLASSWARE_MAX, errors);
  const ice = validateOptionalShortText(input.ice, "ice", LIMITS.ICE_MAX, errors);
  const garnish = validateOptionalShortText(input.garnish, "garnish", LIMITS.GARNISH_MAX, errors);
  const instructions = validateInstructions(input.instructions, "instructions", errors);
  const source = validateSource(input.source, "source", errors);
  const estimated_abv_percent = validateAbv(input.estimated_abv_percent, "estimated_abv_percent", errors);

  if (errors.length) return { valid: false, errors, drink: null };

  return {
    valid: true,
    errors: [],
    drink: {
      name,
      base_spirit,
      tags,
      ingredients,
      technique,
      glassware,
      ice,
      garnish,
      instructions,
      source,
      estimated_abv_percent,
    },
  };
}

function parseAnalysis(rawAnalysis, errors) {
  if (rawAnalysis === undefined || rawAnalysis === null) return null;
  if (typeof rawAnalysis !== "object" || Array.isArray(rawAnalysis)) {
    pushError(errors, "analysis", "deve ser um objeto");
    return null;
  }
  const summary = validateOptionalShortText(rawAnalysis.summary, "analysis.summary", LIMITS.SUMMARY_MAX, errors);
  let confidence = null;
  if (rawAnalysis.confidence !== undefined && rawAnalysis.confidence !== null) {
    const c = normalizeText(rawAnalysis.confidence).toLowerCase();
    if (!CONFIDENCE_VALUES.has(c)) {
      pushError(errors, "analysis.confidence", `valor inválido: ${JSON.stringify(rawAnalysis.confidence)}`);
    } else {
      confidence = c;
    }
  }
  let uncertainties = [];
  if (rawAnalysis.uncertainties !== undefined && rawAnalysis.uncertainties !== null) {
    if (!Array.isArray(rawAnalysis.uncertainties)) {
      pushError(errors, "analysis.uncertainties", "deve ser uma lista de strings");
    } else {
      uncertainties = rawAnalysis.uncertainties
        .slice(0, LIMITS.UNCERTAINTIES_MAX)
        .map((u) => normalizeText(u))
        .filter(Boolean)
        .map((u) => (u.length > LIMITS.UNCERTAINTY_MAX ? u.slice(0, LIMITS.UNCERTAINTY_MAX) : u));
    }
  }
  return { summary, confidence, uncertainties };
}

/**
 * Validates a full AI-generated import payload:
 * { schema_version, drink: {...}, analysis?: {...} }
 * This is the exact contract described to the AI assistant for JSON drafts.
 */
export function validateImportPayload(rawText) {
  if (typeof rawText !== "string") {
    return { valid: false, errors: ["entrada deve ser texto"], drink: null, analysis: null };
  }
  if (rawText.length > LIMITS.PASTE_JSON_MAX_CHARS) {
    return {
      valid: false,
      errors: [`JSON colado excede ${LIMITS.PASTE_JSON_MAX_CHARS} caracteres`],
      drink: null,
      analysis: null,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return { valid: false, errors: [`JSON inválido: ${e.message}`], drink: null, analysis: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, errors: ["o JSON deve ser um objeto"], drink: null, analysis: null };
  }
  const errors = [];
  if (parsed.schema_version !== undefined && typeof parsed.schema_version !== "string") {
    pushError(errors, "schema_version", "deve ser string");
  }
  const { errors: fieldErrors, drink } = validateDrinkFields(parsed.drink);
  errors.push(...fieldErrors);

  const analysis = parseAnalysis(parsed.analysis, errors);

  if (errors.length) return { valid: false, errors, drink: null, analysis: null };
  return { valid: true, errors: [], drink, analysis };
}

/**
 * Validates a bulk import payload for setting up several drinks at once.
 * Accepts either a top-level JSON array of items, or an object of the form
 * { schema_version, drinks: [...] }. Each item has the same shape as a
 * single import payload's body: { drink: {...}, analysis?: {...} }.
 * Every item is validated independently so partial success is possible —
 * the caller decides what to do with the mix of valid/invalid items.
 * Returns { valid, errors, items } where items is
 * [{ index, valid, errors, drink, analysis }].
 */
export function validateBulkImportPayload(rawText) {
  if (typeof rawText !== "string") {
    return { valid: false, errors: ["entrada deve ser texto"], items: [] };
  }
  if (rawText.length > LIMITS.BULK_PASTE_JSON_MAX_CHARS) {
    return {
      valid: false,
      errors: [`JSON colado excede ${LIMITS.BULK_PASTE_JSON_MAX_CHARS} caracteres`],
      items: [],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return { valid: false, errors: [`JSON inválido: ${e.message}`], items: [] };
  }

  let rawItems;
  if (Array.isArray(parsed)) {
    rawItems = parsed;
  } else if (parsed && typeof parsed === "object" && Array.isArray(parsed.drinks)) {
    rawItems = parsed.drinks;
  } else {
    return {
      valid: false,
      errors: ['esperado uma lista (array) de drinks, ou um objeto com "drinks": [...]'],
      items: [],
    };
  }

  if (rawItems.length === 0) {
    return { valid: false, errors: ["a lista está vazia"], items: [] };
  }
  if (rawItems.length > LIMITS.BULK_IMPORT_MAX_ITEMS) {
    return {
      valid: false,
      errors: [`no máximo ${LIMITS.BULK_IMPORT_MAX_ITEMS} drinks por importação em lote`],
      items: [],
    };
  }

  const items = rawItems.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { index, valid: false, errors: ['item deve ser um objeto com "drink": {...}'], drink: null, analysis: null };
    }
    const errors = [];
    const { errors: fieldErrors, drink } = validateDrinkFields(raw.drink);
    errors.push(...fieldErrors);
    const analysis = parseAnalysis(raw.analysis, errors);
    if (errors.length) return { index, valid: false, errors, drink: null, analysis: null };
    return { index, valid: true, errors: [], drink, analysis };
  });

  const validCount = items.filter((i) => i.valid).length;
  return {
    valid: validCount > 0,
    errors: validCount === 0 ? ["nenhum item da lista é válido"] : [],
    items,
  };
}

// ---------- record-level validators (rating, comment, status) ----------

export function validateRating(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isInteger(n) || n < 1 || n > 5) return undefined; // undefined = invalid
  return n;
}

export function validateComment(value) {
  const text = normalizeText(value);
  return text.length > LIMITS.COMMENT_MAX ? text.slice(0, LIMITS.COMMENT_MAX) : text;
}

export function validateStatus(value) {
  const v = normalizeText(value).toLowerCase();
  return STATUS_VALUES.has(v) ? v : "want_to_try";
}

// ---------- date helpers (used to reject impossible dates on import) ----------

/** Returns true if the ISO string is a real, parseable date-time. */
export function isValidIsoDate(value) {
  if (typeof value !== "string" || !value) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  // Reject dates that round-trip incorrectly (e.g. "2026-02-30").
  return d.toISOString().slice(0, 10) === value.slice(0, 10) || value.includes("T");
}

// ---------- backup payload validation ----------

export const BACKUP_LIMITS = {
  MAX_RECORDS: 500,
  MAX_PHOTO_BYTES: 6 * 1024 * 1024,
  MAX_TOTAL_PHOTO_BYTES: 20 * 1024 * 1024,
  MAX_BACKUP_BYTES: 30 * 1024 * 1024,
};

function estimateBase64Bytes(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const len = b64.length;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Validates a parsed backup object structurally, without decoding photo
 * bytes. Returns { valid, errors, recordCount, estimatedPhotoBytes }.
 */
export function validateBackupStructure(parsed, totalFileBytes) {
  const errors = [];
  if (!parsed || typeof parsed !== "object") {
    return { valid: false, errors: ["backup: JSON inválido"], recordCount: 0 };
  }
  if (typeof parsed.backup_version !== "string") {
    pushError(errors, "backup_version", "obrigatório");
  }
  if (!isValidIsoDate(parsed.exported_at)) {
    pushError(errors, "exported_at", "data inválida");
  }
  if (!Array.isArray(parsed.records)) {
    pushError(errors, "records", "deve ser uma lista");
    return { valid: false, errors, recordCount: 0 };
  }
  if (parsed.records.length > BACKUP_LIMITS.MAX_RECORDS) {
    pushError(errors, "records", `no máximo ${BACKUP_LIMITS.MAX_RECORDS} registros por backup`);
  }
  if (totalFileBytes !== undefined && totalFileBytes > BACKUP_LIMITS.MAX_BACKUP_BYTES) {
    pushError(errors, "file", `arquivo maior que o limite de ${BACKUP_LIMITS.MAX_BACKUP_BYTES} bytes`);
  }

  let totalPhotoBytes = 0;
  parsed.records.slice(0, BACKUP_LIMITS.MAX_RECORDS).forEach((rec, i) => {
    const p = `records[${i}]`;
    if (!rec || typeof rec !== "object") {
      pushError(errors, p, "registro inválido");
      return;
    }
    const { valid, errors: fieldErrors } = validateDrinkFields(rec.import_data);
    if (!valid) fieldErrors.forEach((e) => pushError(errors, `${p}.import_data`, e));
    if (!isValidIsoDate(rec.created_at)) pushError(errors, `${p}.created_at`, "data inválida");
    if (!isValidIsoDate(rec.updated_at)) pushError(errors, `${p}.updated_at`, "data inválida");
    if (rec.status !== undefined && !STATUS_VALUES.has(rec.status)) {
      pushError(errors, `${p}.status`, "status inválido");
    }

    for (const slot of ["primary", "secondary"]) {
      const photo = rec.photos && rec.photos[slot];
      if (!photo) continue;
      if (typeof photo.data !== "string" || !photo.data.startsWith("data:")) {
        pushError(errors, `${p}.photos.${slot}`, "foto malformada");
        continue;
      }
      const bytes = estimateBase64Bytes(photo.data);
      if (bytes > BACKUP_LIMITS.MAX_PHOTO_BYTES) {
        pushError(errors, `${p}.photos.${slot}`, "foto excede o limite individual");
        continue;
      }
      totalPhotoBytes += bytes;
      if (totalPhotoBytes > BACKUP_LIMITS.MAX_TOTAL_PHOTO_BYTES) {
        pushError(errors, "photos", "total de fotos excede o limite do backup");
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    recordCount: parsed.records.length,
    estimatedPhotoBytes: totalPhotoBytes,
  };
}
