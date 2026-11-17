/* ---------- PG core: reading the file and working out the figures. Pure functions, no DOM. ---------- */
const PG = (() => {
  'use strict';

  /* ===== reading delimited text ===== */
  const stripBom = s => (s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);

  function detectDelimiter(text) {
    const lines = []; let cur = '', inQ = false;
    for (let i = 0; i < text.length && lines.length < 30; i++) {
      const ch = text[i];
      if (ch === '"') { inQ = !inQ; cur += ch; }
      else if (ch === '\n' && !inQ) { if (cur.trim() !== '') lines.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.trim() !== '' && lines.length < 30) lines.push(cur);
    if (!lines.length) return ',';
    const pref = { '\t': 120, ';': 80, '|': 40, ',': 0 };   // tabs and semicolons rarely occur inside values, commas often do
    let best = ',', bestScore = -1;
    for (const d of ['\t', ';', '|', ',']) {
      const counts = lines.map(l => { let n = 0, q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === d && !q) n++; } return n; });
      const freq = new Map(); counts.forEach(c => freq.set(c, (freq.get(c) || 0) + 1));
      let mode = 0, modeN = 0;
      for (const [c, n] of freq) if (c > 0 && (n > modeN || (n === modeN && c > mode))) { mode = c; modeN = n; }
      const score = mode > 0 ? (modeN / lines.length) * 1000 + Math.min(mode, 50) + pref[d] : 0;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  // RFC 4180 style reader: quoted fields, doubled quotes, delimiters and line breaks inside quotes.
  function parseDelimited(text, delimiter) {
    text = stripBom(String(text)).replace(/\r\n?/g, '\n');
    const d = delimiter || detectDelimiter(text);
    const rows = []; let row = [], field = '', inQ = false, i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
        field += ch; i++; continue;
      }
      if (ch === '"' && field === '') { inQ = true; i++; continue; }
      if (ch === d) { row.push(field); field = ''; i++; continue; }
      if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += ch; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return { delimiter: d, rows };
  }

  // First non-empty row is the header. rowNums are spreadsheet row numbers (header = 1), so messages can point at a row.
  function toTable(text, delimiter) {
    const p = parseDelimited(text, delimiter);
    const kept = [], nums = [];
    p.rows.forEach((r, i) => { if (r.some(c => String(c).trim() !== '')) { kept.push(r); nums.push(i + 1); } });
    if (!kept.length) return { delimiter: p.delimiter, headers: [], rows: [], rowNums: [] };
    const width = kept.reduce((m, r) => Math.max(m, r.length), 0);
    const seen = new Map();
    const headers = Array.from({ length: width }, (_, i) => {
      let h = String(kept[0][i] == null ? '' : kept[0][i]).replace(/\s+/g, ' ').trim() || ('Column ' + (i + 1));
      const k = h.toLowerCase(); const n = (seen.get(k) || 0) + 1; seen.set(k, n);
      return n > 1 ? h + ' (' + n + ')' : h;
    });
    const rows = kept.slice(1).map(r => Array.from({ length: width }, (_, i) => (r[i] == null ? '' : String(r[i]))));
    return { delimiter: p.delimiter, headers, rows, rowNums: nums.slice(1) };
  }

  /* ===== numbers written the way payroll systems write them ===== */
  function cleanNum(raw) {
    let s = String(raw == null ? '' : raw).trim(); let neg = false;
    if (!s) return { s: '', neg };
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[−–]/g, '-').replace(/[^\d.,\-]/g, '');   // drops currency signs, spaces, apostrophes, letters
    if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    return { s, neg };
  }

  // Which character is the decimal mark in this column? ',' or '.' or null when nothing in the column settles it.
  function inferDecimal(values) {
    let comma = 0, dot = 0;
    for (const raw of values) {
      const s = cleanNum(raw).s; if (!s) continue;
      const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
      if (lc >= 0 && ld >= 0) { if (lc > ld) comma += 3; else dot += 3; continue; }
      const sep = lc >= 0 ? ',' : ld >= 0 ? '.' : null; if (!sep) continue;
      const parts = s.split(sep), after = parts[parts.length - 1].length;
      const vote = n => { if (sep === ',') comma += n; else dot += n; };
      const against = n => { if (sep === ',') dot += n; else comma += n; };
      if (parts.length === 2) { if (after !== 3 || parts[0] === '0' || parts[0] === '') vote(2); }
      else if (parts.slice(1).every(g => g.length === 3)) against(1);   // 1,234,567 is grouping
    }
    return comma > dot ? ',' : dot > comma ? '.' : null;
  }

  function parseNumber(raw, dec) {
    const c = cleanNum(raw); let s = c.s; if (!s || !/\d/.test(s)) return null;
    if (dec === ',') s = s.replace(/\./g, '').replace(',', '.');
    else if (dec === '.') s = s.replace(/,/g, '');
    else s = s.replace(/[.,](?=\d{3}(?:[.,]|$))/g, '').replace(',', '.');   // undecided: a mark followed by exactly three digits is grouping
    if (!/^\d*\.?\d*$/.test(s)) return null;
    const n = Number(s); return Number.isFinite(n) ? (c.neg ? -n : n) : null;
  }

  /* ===== guessing what each column is ===== */
  const norm = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/[^a-z0-9%]+/g, ' ').trim();

  const ROLE_WORDS = {
    gender: 'gender|sex|geschlecht|sexe|genre|sexo|genero|genere|sesso|geslacht|plec|kon|kjonn|sukupuoli|m f|m w|h f|f m',
    base: 'base pay|base salary|basic pay|basic salary|basic wage|base wage|annual salary|annual base|gross salary|gross pay|salary|base|basic|grundgehalt|grundlohn|grundentgelt|grundvergutung|bruttogehalt|jahresgehalt|monatsgehalt|gehalt|entgelt|lohn|stundenlohn|salaire de base|salaire brut|salaire|remuneration de base|traitement|sueldo base|salario base|sueldo bruto|sueldo|salario|retribucion|stipendio base|retribuzione base|stipendio|retribuzione|paga base|basissalaris|brutosalaris|bruto salaris|salaris|loon|uurloon|wynagrodzenie zasadnicze|placa zasadnicza|wynagrodzenie|pensja|stawka|vencimento base|vencimento|remuneracao base|ordenado|hourly rate|hourly pay|hourly wage|pay rate|rate|wage|pay',
    variable: 'bonus|bonuses|variable pay|variable|commission|commissions|incentive|incentives|allowance|allowances|overtime|premium|premiums|shift pay|13th|benefits in kind|benefit|benefits|pramie|praemie|pramien|zulage|zulagen|zuschlag|zuschlage|provision|sonderzahlung|sonderzahlungen|tantieme|weihnachtsgeld|urlaubsgeld|variabel|variable vergutung|prime|primes|part variable|interessement|participation|avantage|avantages|heures supplementaires|bono|bonos|incentivo|incentivos|comision|comisiones|complemento|complementos|pluses|horas extra|horas extras|premio|premi|variabile|straordinario|straordinari|indennita|provvigione|provvigioni|toeslag|toeslagen|provisie|overwerk|dertiende maand|vakantiegeld|premia|premie|dodatek|dodatki|nadgodziny|prowizja|zmienne|premios|comissao|comissoes|subsidio|subsidios|variavel',
    hours: 'weekly hours|hours per week|hours week|contract hours|contracted hours|working hours|hours|hrs|wochenstunden|wochenarbeitszeit|arbeitszeit|stunden|heures hebdomadaires|heures hebdo|heures|horaire hebdomadaire|duree du travail|horas semanales|horas semana|horas|ore settimanali|ore|orario|uren per week|uren|godziny|wymiar godzin|horas semanais',
    fte: 'fte|full time equivalent|part time|employment rate|employment percentage|work percentage|percent|beschaftigungsgrad|teilzeitgrad|teilzeitfaktor|pensum|vza|stellenumfang|arbeitszeitanteil|etp|taux d activite|quotite|taux|temps de travail|jornada|parcialidad|porcentaje jornada|percentuale part time|percentuale|deeltijdfactor|parttime factor|parttimepercentage|deeltijd|wymiar etatu|etat|percentagem',
    category: 'category of workers|worker category|job category|category|job grade|pay grade|grade|job level|level|pay band|band|job family|job group|job title|position|role|entgeltgruppe|tarifgruppe|vergleichsgruppe|lohngruppe|gehaltsgruppe|stufe|funktionsgruppe|gruppe|tatigkeit|stelle|categorie|classification|niveau|coefficient|emploi|poste|categoria|grupo profesional|grupo|nivel|puesto|livello|inquadramento|qualifica|mansione|functiegroep|functieniveau|schaal|functie|kategoria|grupa|stanowisko|poziom|zaszeregowanie|funcao|cargo',
    id: 'employee id|employee number|employee no|emp id|staff id|staff number|personnel number|person id|worker id|id|personalnummer|personalnr|mitarbeiternummer|matricule|numero employe|identifiant|numero empleado|id empleado|matricola|codice dipendente|personeelsnummer|medewerkernummer|numer pracownika|nr pracownika|numero funcionario|numero colaborador|name|nom|nombre|nome|naam|nazwisko',
  };
  const ROLE_LIST = Object.fromEntries(Object.entries(ROLE_WORDS).map(([k, v]) => [k, v.split('|')]));

  function headerScore(h, role) {
    let best = 0;
    for (const w of ROLE_LIST[role]) {
      let s = 0;
      if (h === w) s = 100;
      else if ((' ' + h + ' ').includes(' ' + w + ' ')) s = 70;
      else if (w.length >= 5 && h.includes(w)) s = 45;      // compound words: Jahresgrundgehalt, Bruttomonatslohn
      if (s) best = Math.max(best, s + Math.min(w.length, 20));
    }
    return best;
  }

  const G_WORDS = {
    M: 'm|male|man|men|mann|manner|mannlich|maennlich|herr|h|homme|hommes|masculin|hombre|hombres|masculino|varon|uomo|uomini|maschio|maschile|mannelijk|mezczyzna|mezczyzni|homem|homens|masc|mand|mies',
    F: 'f|female|woman|women|frau|frauen|weiblich|w|femme|femmes|feminin|mujer|mujeres|femenino|femenina|donna|donne|femmina|femminile|vrouw|vrouwen|vrouwelijk|v|k|kobieta|kobiety|mulher|mulheres|feminino|feminina|fem|kvinna|kvinde|nainen',
    O: 'd|x|divers|diverse|non binary|nonbinary|nb|other|autre|otro|otra|altro|anders|inny|inna|outro|outra|inter|unknown|unbekannt|na|n a|not stated|not specified|prefer not to say|undisclosed',
  };
  const G_LOOKUP = new Map();
  for (const g of ['M', 'F', 'O']) for (const w of G_WORDS[g].split('|')) G_LOOKUP.set(w, g);

  // -> { g: 'F' | 'M' | 'O', known: boolean }.  'O' = another gender or none recorded.
  function guessGender(raw) {
    const n = norm(raw);
    if (n === '') return { g: 'O', known: true };
    const g = G_LOOKUP.get(n);
    return g ? { g, known: true } : { g: 'O', known: false };
  }

  const MONTH_WORDS = 'month|monthly|monat|monatlich|monats|monatsgehalt|monatslohn|mensuel|mensuelle|mensual|mensile|maand|maandelijks|miesiac|miesieczne|miesieczna|mensal|mes'.split('|');
  const HOUR_WORDS = 'hour|hourly|stunde|stundenlohn|horaire|hora|ora|oraria|uur|uurloon|godzinowa|godzina'.split('|');
  const hasWord = (h, list) => list.some(w => (' ' + h + ' ').includes(' ' + w + ' ') || (w.length >= 6 && h.includes(w)));

  function distinct(table, c) { const m = new Map(); for (const r of table.rows) { const v = String(r[c]).trim(); m.set(v, (m.get(v) || 0) + 1); } return m; }

  function guessMapping(table) {
    const H = table.headers.map(norm);
    const mp = { gender: -1, base: -1, variable: [], timeCol: -1, timeKind: 'none', ftHours: 40, category: -1, id: -1,
      payBasis: 'annual', variableBasis: 'annual', payIsFte: false, decimal: 'auto', currency: '€', genderMap: {} };
    const cand = [];
    H.forEach((h, c) => { for (const role of Object.keys(ROLE_LIST)) { const s = headerScore(h, role); if (s) cand.push({ role, c, s }); } });
    cand.sort((a, b) => b.s - a.s || a.c - b.c);
    const used = new Set(); let timeRole = null;
    for (const k of cand) {
      if (used.has(k.c)) continue;
      if (k.role === 'variable') { if (k.s >= 60) { mp.variable.push(k.c); used.add(k.c); } continue; }
      if (k.role === 'hours' || k.role === 'fte') { if (mp.timeCol < 0) { mp.timeCol = k.c; timeRole = k.role; used.add(k.c); } continue; }
      if (mp[k.role] < 0) { mp[k.role] = k.c; used.add(k.c); }
    }
    mp.variable.sort((a, b) => a - b);
    // no header said "gender": look for a column whose values are all gender words
    if (mp.gender < 0) {
      for (let c = 0; c < table.headers.length; c++) {
        if (used.has(c)) continue;
        const d = distinct(table, c); if (d.size < 2 || d.size > 8) continue;
        let known = 0, total = 0, fm = new Set();
        for (const [v, n] of d) { total += n; const g = guessGender(v); if (g.known && v !== '') { known += n; fm.add(g.g); } }
        if (total && known / total >= 0.9 && fm.has('F') && fm.has('M')) { mp.gender = c; used.add(c); break; }
      }
    }
    if (mp.timeCol >= 0) {
      const vals = table.rows.map(r => parseNumber(r[mp.timeCol], inferDecimal(table.rows.map(x => x[mp.timeCol])))).filter(v => v != null && v > 0);
      const max = vals.reduce((m, v) => Math.max(m, v), 0);
      if (!vals.length) mp.timeKind = timeRole === 'fte' ? 'fte' : 'hours';
      else if (max <= 1.5) mp.timeKind = 'fte';                       // 0.5, 0.8, 1 = fraction of full time
      else if (max > 60) mp.timeKind = 'fte';                         // 50, 80, 100 = per cent of full time
      else mp.timeKind = 'hours';                                     // 20, 32, 38.5, 40 = hours a week
      if (mp.timeKind === 'hours' && vals.length) {                   // full-time week = the most common value among the larger ones
        const f = new Map(); vals.forEach(v => f.set(v, (f.get(v) || 0) + 1));
        let top = 40, topN = 0; for (const [v, n] of f) if (v >= 30 && v <= 48 && (n > topN || (n === topN && v > top))) { top = v; topN = n; }
        if (topN > 0) mp.ftHours = top;
      }
    }
    if (mp.base >= 0) { const h = H[mp.base]; mp.payBasis = hasWord(h, HOUR_WORDS) ? 'hourly' : hasWord(h, MONTH_WORDS) ? 'monthly' : 'annual'; }
    if (mp.variable.length && mp.variable.every(c => hasWord(H[c], MONTH_WORDS))) mp.variableBasis = 'monthly';
    if (mp.gender >= 0) for (const v of distinct(table, mp.gender).keys()) mp.genderMap[v] = guessGender(v).g;
    return mp;
  }

  /* ===== statistics ===== */
  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // Art. 3(1)(c): difference between men's and women's level as a percentage of men's. Positive = men paid more.
  const gapPct = (m, f) => (m == null || f == null || !(m > 0) ? null : (m - f) / m * 100);
  const FLAG_AT = 5;
  const isFlag = gap => gap != null && Math.abs(gap) >= FLAG_AT - 1e-9;

  const WEEKS = 52;

  function buildWorkers(table, mp) {
    const decCache = {};
    const decFor = c => (mp.decimal === ',' || mp.decimal === '.') ? mp.decimal : (c in decCache ? decCache[c] : (decCache[c] = inferDecimal(table.rows.map(r => r[c]))));
    const ft = mp.ftHours > 0 ? Number(mp.ftHours) : 40;
    let timeVals = null, ftePercent = false;
    if (mp.timeKind !== 'none' && mp.timeCol >= 0) {
      timeVals = table.rows.map(r => parseNumber(r[mp.timeCol], decFor(mp.timeCol)));
      if (mp.timeKind === 'fte') { const pos = timeVals.filter(v => v != null && v > 0); ftePercent = pos.length > 0 && median(pos) > 1.5; }
    }
    const workers = [], dropped = [];
    table.rows.forEach((r, i) => {
      const row = table.rowNums[i];
      const gRaw = mp.gender >= 0 ? String(r[mp.gender]).trim() : '';
      const g = mp.gender < 0 ? 'O' : (mp.genderMap && mp.genderMap[gRaw]) || guessGender(gRaw).g;
      const baseV = mp.base >= 0 ? parseNumber(r[mp.base], decFor(mp.base)) : null;
      if (baseV == null) { dropped.push({ row, reason: 'no base pay' }); return; }
      if (!(baseV > 0)) { dropped.push({ row, reason: 'base pay is zero or negative' }); return; }
      let weekly = ft, fte = 1;
      if (timeVals) {
        const t = timeVals[i];
        if (t == null || !(t > 0)) { dropped.push({ row, reason: 'no working time' }); return; }
        if (mp.timeKind === 'hours') { weekly = t; fte = t / ft; } else { fte = ftePercent ? t / 100 : t; weekly = fte * ft; }
      }
      const hours = weekly * WEEKS;
      let variable = 0;
      for (const c of mp.variable || []) { const v = parseNumber(r[c], decFor(c)); if (v != null) variable += v; }
      if (mp.variableBasis === 'monthly') variable *= 12;
      let baseA, baseH;
      if (mp.payBasis === 'hourly') { baseH = baseV; baseA = baseV * hours; }
      else { baseA = baseV * (mp.payBasis === 'monthly' ? 12 : 1) * (mp.payIsFte ? fte : 1); baseH = baseA / hours; }
      const cat = mp.category >= 0 ? (String(r[mp.category]).replace(/\s+/g, ' ').trim() || '(no category)') : '';
      workers.push({ row, g, cat, baseA, varA: variable, totA: baseA + variable, baseH, varH: variable / hours, totH: baseH + variable / hours, hours, weekly, fte, hasVar: variable > 0 });
    });
    return { workers, dropped, ftePercent, total: table.rows.length };
  }

  // Art. 3(1)(f): four equal groups, lowest to highest. Workers on exactly the same pay who straddle a boundary are shared
  // between the two bands in proportion, so the result does not depend on the order of rows in the file.
  function quartileBands(W, key) {
    const s = [...W].sort((x, y) => x[key] - y[key]), n = s.length;
    const cuts = [0, Math.round(n / 4), Math.round(n / 2), Math.round(3 * n / 4), n];
    const bands = [0, 1, 2, 3].map(q => ({ band: q + 1, size: cuts[q + 1] - cuts[q], f: 0, m: 0, min: null, max: null }));
    bands.forEach((b, q) => { if (b.size > 0) { b.min = s[cuts[q]][key]; b.max = s[cuts[q + 1] - 1][key]; } });
    let i = 0;
    while (i < n) {
      let j = i; while (j < n && s[j][key] === s[i][key]) j++;
      let fc = 0; for (let k = i; k < j; k++) if (s[k].g === 'F') fc++;
      const t = j - i, mc = t - fc;
      for (let q = 0; q < 4; q++) {
        const o = Math.max(0, Math.min(j, cuts[q + 1]) - Math.max(i, cuts[q]));
        if (o > 0) { bands[q].f += o * fc / t; bands[q].m += o * mc / t; }
      }
      i = j;
    }
    bands.forEach(b => { b.fPct = b.size ? b.f / b.size * 100 : null; b.mPct = b.size ? b.m / b.size * 100 : null; });
    return bands;
  }

  function computeBasis(W, basis, varAmong, minGroup) {
    const K = basis === 'annual' ? { b: 'baseA', v: 'varA', t: 'totA' } : { b: 'baseH', v: 'varH', t: 'totH' };
    const F = W.filter(w => w.g === 'F'), M = W.filter(w => w.g === 'M');
    const rec = a => (varAmong === 'all' ? a : a.filter(w => w.hasVar));
    const pair = (fa, ma, k, fn) => { const f = fn(fa.map(w => w[k])), m = fn(ma.map(w => w[k])); return { f, m, gap: gapPct(m, f) }; };
    const a = pair(F, M, K.t, mean);
    const b = Object.assign(pair(rec(F), rec(M), K.v, mean), { nF: rec(F).length, nM: rec(M).length });
    const c = pair(F, M, K.t, median);
    const d = Object.assign(pair(rec(F), rec(M), K.v, median), { nF: rec(F).length, nM: rec(M).length });
    const e = { fN: F.filter(w => w.hasVar).length, mN: M.filter(w => w.hasVar).length, fTot: F.length, mTot: M.length };
    e.fPct = F.length ? e.fN / F.length * 100 : null; e.mPct = M.length ? e.mN / M.length * 100 : null;
    const f = quartileBands(F.concat(M), K.t);
    const groups = new Map();
    for (const w of F.concat(M)) { if (w.cat === '') continue; if (!groups.has(w.cat)) groups.set(w.cat, { F: [], M: [] }); groups.get(w.cat)[w.g].push(w); }
    const g = [];
    for (const [name, c2] of groups) {
      const base = pair(c2.F, c2.M, K.b, mean), variable = pair(rec(c2.F), rec(c2.M), K.v, mean), total = pair(c2.F, c2.M, K.t, mean);
      const single = !c2.F.length || !c2.M.length;
      const row = { name, fN: c2.F.length, mN: c2.M.length, base, variable, total, single,
        fragile: !single && (c2.F.length < minGroup || c2.M.length < minGroup), flagged: isFlag(total.gap), lower: null, cost: null,
        varFN: rec(c2.F).length, varMN: rec(c2.M).length };
      if (total.gap != null && total.gap !== 0) {
        row.lower = total.gap > 0 ? 'F' : 'M';
        const L = row.lower === 'F' ? c2.F : c2.M, diff = Math.abs(total.m - total.f);
        row.cost = basis === 'annual' ? diff * L.length : diff * L.reduce((s, w) => s + w.hours, 0);
      }
      g.push(row);
    }
    g.sort((x, y) => (x.single - y.single) || (Math.abs(y.total.gap || 0) - Math.abs(x.total.gap || 0)) || x.name.localeCompare(y.name));
    return { basis, a, b, c, d, e, f, g, flagged: g.filter(r => r.flagged), nF: F.length, nM: M.length };
  }

  /* ===== preflight checks on the data ===== */
  function qualityNotes(built, mp, minGroup) {
    const W = built.workers, FM = W.filter(w => w.g === 'F' || w.g === 'M');
    const out = { droppedByReason: {}, other: W.filter(w => w.g === 'O').length, smallGroups: [], singleGender: [], outliers: [], extreme: [], oddTime: [], fteLooksNormalised: false, ftePercent: built.ftePercent };
    for (const d of built.dropped) (out.droppedByReason[d.reason] = out.droppedByReason[d.reason] || []).push(d.row);
    const cats = new Map();
    for (const w of FM) { if (w.cat === '') continue; if (!cats.has(w.cat)) cats.set(w.cat, { F: 0, M: 0, all: [] }); const c = cats.get(w.cat); c[w.g]++; c.all.push(w); }
    for (const [name, c] of cats) {
      if (!c.F || !c.M) out.singleGender.push({ name, fN: c.F, mN: c.M });
      else if (c.F < minGroup || c.M < minGroup) out.smallGroups.push({ name, fN: c.F, mN: c.M });
    }
    // pay far from the rest of the same category (robust z on log hourly pay), or wildly off the whole file
    const gmed = median(W.map(w => w.totH));
    const groups = cats.size ? [...cats.values()].map(c => c.all) : [W];
    for (const grp of groups) {
      if (grp.length < 8) continue;
      const logs = grp.map(w => Math.log(w.totH)), med = median(logs), mad = median(logs.map(x => Math.abs(x - med)));
      if (!(mad > 0)) continue;
      grp.forEach((w, i) => { const z = 0.6745 * (logs[i] - med) / mad, ratio = Math.exp(logs[i] - med); if (Math.abs(z) > 4 && (ratio > 1.8 || ratio < 0.55)) out.outliers.push({ row: w.row, ratio }); });
    }
    if (gmed > 0) for (const w of W) { const r = w.totH / gmed; if (r > 12 || r < 1 / 12) out.extreme.push({ row: w.row, ratio: r }); }
    out.outliers.sort((x, y) => x.row - y.row); out.extreme.sort((x, y) => x.row - y.row);
    for (const w of W) if (w.weekly > 60 || w.fte > 1.5 || w.weekly < 1) out.oddTime.push(w.row);
    // part-timers who come out far better paid per hour than full-time colleagues: pay columns are probably full-time-equivalent amounts
    if (mp && mp.payBasis !== 'hourly' && !mp.payIsFte) {
      const r = [], rf = [];
      for (const grp of groups) {
        const ftm = median(grp.filter(w => w.fte >= 0.95).map(w => w.baseH)); if (!ftm) continue;
        for (const w of grp) if (w.fte < 0.9) { r.push(w.baseH / ftm); rf.push(w.baseH * w.fte / ftm); }
      }
      if (r.length >= 5 && median(r) >= 1.2 && Math.abs(median(rf) - 1) < 0.12) out.fteLooksNormalised = true;
    }
    return out;
  }

  /* ===== reporting clock, Art. 9(2) to 9(5) ===== */
  function reportingClock(headcount, today) {
    const due = y => new Date(Date.UTC(y, 5, 7));
    const day0 = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    let band, first, step, art;
    if (headcount >= 250) { band = '250 or more workers'; first = 2027; step = 1; art = 'Art. 9(2)'; }
    else if (headcount >= 150) { band = '150 to 249 workers'; first = 2027; step = 3; art = 'Art. 9(3)'; }
    else if (headcount >= 100) { band = '100 to 149 workers'; first = 2031; step = 3; art = 'Art. 9(4)'; }
    else return { band: 'fewer than 100 workers', due: null, art: 'Art. 9(5)', cadence: null, dataYear: null, daysLeft: null, isFirst: false };
    let y = first; while (due(y).getTime() < day0) y += step;
    return { band, due: due(y), art, cadence: step === 1 ? 'every year' : 'every three years', dataYear: y - 1,
      daysLeft: Math.round((due(y).getTime() - day0) / 86400000), isFirst: y === first };
  }

  /* ===== text formats ===== */
  const MONTHS = 'January February March April May June July August September October November December'.split(' ');
  const fmtDate = d => d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  function fmtNum(x, dp) {
    if (x == null || !Number.isFinite(x)) return '–';
    const neg = x < 0; let s = Math.abs(x).toFixed(dp); let [i, f] = s.split('.');
    i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '−' : '') + i + (f ? '.' + f : '');
  }
  const fmtInt = x => fmtNum(x, 0);
  // One decimal, except just under the 5% line, where rounding would print "5.0%" for a gap that does not reach it.
  function fmtGap(g) {
    if (g == null || !Number.isFinite(g)) return 'n/a';
    const a = Math.abs(g); let dp = 1;
    if (a < FLAG_AT - 1e-9 && a >= FLAG_AT - 0.05) dp = a >= FLAG_AT - 0.005 ? 3 : 2;
    return fmtNum(g, dp) + '%';
  }
  const fmtPct = p => (p == null || !Number.isFinite(p) ? 'n/a' : fmtNum(p, 1) + '%');
  const fmtMoney = (x, cur, dp) => (x == null || !Number.isFinite(x) ? '–' : (x < 0 ? '−' : '') + (cur || '') + fmtNum(Math.abs(x), dp == null ? 2 : dp));
  const fmtCount = x => (Math.abs(x - Math.round(x)) < 1e-9 ? String(Math.round(x)) : x.toFixed(1));   // tie-shared quartile counts can be fractional

  const csvCell = v => { const s = String(v == null ? '' : v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function categoryCsv(R, o) {
    const unit = R.basis === 'annual' ? 'per year' : 'per hour', min = (o && o.minGroup) || 5;
    const head = ['Category of workers', 'Women', 'Men', 'Women average basic pay (' + unit + ')', 'Men average basic pay (' + unit + ')', 'Basic pay gap %',
      'Women average variable pay (' + unit + ')', 'Men average variable pay (' + unit + ')', 'Variable pay gap %',
      'Women average pay level (' + unit + ')', 'Men average pay level (' + unit + ')', 'Pay level gap %', 'At or over 5% (Art. 10(1)(a))', 'Estimated yearly cost to close', 'Note'];
    const n2 = x => (x == null ? '' : x.toFixed(2)), n0 = x => (x == null ? '' : String(Math.round(x)));
    const lines = [head.map(csvCell).join(',')];
    for (const r of R.g) {
      const hide = !!(o && o.suppress && r.fragile);
      const small = n => (hide && n < min ? '<' + min : n);
      const note = r.single ? 'one gender only: no gap to compute' : r.fragile ? 'fewer than ' + min + ' women or men' + (hide ? ': figures suppressed' : '') : '';
      const cells = hide || r.single
        ? [r.name, small(r.fN), small(r.mN), '', '', '', '', '', '', '', '', '', hide ? 'suppressed' : '', '', note]
        : [r.name, r.fN, r.mN, n2(r.base.f), n2(r.base.m), n2(r.base.gap), n2(r.variable.f), n2(r.variable.m), n2(r.variable.gap), n2(r.total.f), n2(r.total.m), n2(r.total.gap), r.flagged ? 'yes' : 'no', r.flagged ? n0(r.cost) : '', note];
      lines.push(cells.map(csvCell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  // Plain-text summary for an email to the CFO or the works council.
  function summaryText(x) {
    const R = x.R, annual = R.basis === 'annual', unit = annual ? ' a year' : ' an hour', dp = annual ? 0 : 2, min = x.minGroup || 5;
    const money = v => fmtMoney(v, x.cur, dp) + unit;
    const L = [];
    L.push('Gender pay gap preflight: ' + x.employer + (x.example ? ' (fictional example data)' : ''));
    L.push('Prepared ' + fmtDate(x.today) + '. Figures follow Article 9(1) of Directive (EU) 2023/970. Pay level basis: gross ' + (annual ? 'annual' : 'hourly') + ' pay.');
    L.push('');
    L.push('Workers in the file: ' + fmtInt(x.counts.total) + ' (' + fmtInt(x.counts.F) + ' women, ' + fmtInt(x.counts.M) + ' men'
      + (x.counts.O ? ', ' + fmtInt(x.counts.O) + ' with another or no gender recorded' : '') + (x.counts.dropped ? ', ' + fmtInt(x.counts.dropped) + ' rows left out' : '') + ')');
    if (x.clock.due) L.push('Reporting date: ' + fmtDate(x.clock.due) + ', covering calendar year ' + x.clock.dataYear + ', then ' + x.clock.cadence + ' (' + x.clock.band + ', ' + x.clock.art + '; headcount used: ' + fmtInt(x.headcount) + ')');
    else L.push('Reporting date: none under the directive for fewer than 100 workers (Art. 9(5)); national law may still require a report (headcount used: ' + fmtInt(x.headcount) + ')');
    L.push('');
    const who = x.varAmong === 'all' ? 'all workers' : 'workers who receive it';
    L.push('(a) Gender pay gap, mean: ' + fmtGap(R.a.gap) + ' (women ' + money(R.a.f) + ', men ' + money(R.a.m) + ')');
    L.push('(b) Gap in complementary or variable components, mean, among ' + who + ': ' + fmtGap(R.b.gap) + (R.b.gap == null ? '' : ' (women ' + money(R.b.f) + ', men ' + money(R.b.m) + ')'));
    L.push('(c) Median gender pay gap: ' + fmtGap(R.c.gap) + ' (women ' + money(R.c.f) + ', men ' + money(R.c.m) + ')');
    L.push('(d) Median gap in complementary or variable components, among ' + who + ': ' + fmtGap(R.d.gap) + (R.d.gap == null ? '' : ' (women ' + money(R.d.f) + ', men ' + money(R.d.m) + ')'));
    L.push('(e) Receiving complementary or variable components: ' + fmtPct(R.e.fPct) + ' of women (' + R.e.fN + ' of ' + R.e.fTot + '), ' + fmtPct(R.e.mPct) + ' of men (' + R.e.mN + ' of ' + R.e.mTot + ')');
    const names = ['lower', 'lower middle', 'upper middle', 'upper'];
    L.push('(f) Quartile pay bands, women / men: ' + R.f.map((b, i) => names[i] + ' ' + fmtPct(b.fPct) + ' / ' + fmtPct(b.mPct)).join('; '));
    if (!R.g.length) L.push('(g) Gap by category of workers: no category column in the file, so not computed');
    else {
      L.push('(g) Gap by category of workers: ' + R.flagged.length + ' of ' + R.g.length + (R.g.length === 1 ? ' category is' : ' categories are') + ' at or over the 5% line in Article 10(1)(a)');
      for (const r of R.g) {
        if (r.single) { L.push('    ' + r.name + ': one gender only, no gap to compute'); continue; }
        if (x.suppress && r.fragile) { L.push('    ' + r.name + ': fewer than ' + min + ' women or men, figures suppressed'); continue; }
        L.push('    ' + r.name + ': pay level ' + fmtGap(r.total.gap) + ', basic pay ' + fmtGap(r.base.gap) + ', variable ' + fmtGap(r.variable.gap)
          + ' (' + r.fN + ' women, ' + r.mN + ' men)' + (r.flagged ? '  << at or over 5%; rough cost to close ' + fmtMoney(r.cost, x.cur, 0) + ' a year' : '') + (r.fragile ? '  [small group]' : ''));
      }
    }
    L.push('');
    L.push('A positive gap means men are paid more; a negative gap means women are paid more. A category at or over 5% leads to a joint pay assessment only if the difference is not justified by objective, gender-neutral criteria and is not remedied within six months of the report (Art. 10(1)).');
    L.push('This is a calculation aid, not legal advice. National law may define pay, working time and categories differently.');
    return L.join('\n');
  }

  /* ===== the example employer (fictional; drawn from a fixed seed so everyone sees the same figures) ===== */
  function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const EXAMPLE_NAME = 'Brandt & Marlow Logistics';
  function exampleTable() {
    const rnd = mulberry32(EXAMPLE_SEED);
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    //            name                              women men  base   spread  women's base  variable: men (share, amount)  women (share, amount)   part-time share women/men
    const cats = EXAMPLE_CATS;
    const rows = []; let id = 1041;
    for (const c of cats) {
      for (const g of ['F', 'M']) {
        const n = g === 'F' ? c.w : c.m;
        for (let k = 0; k < n; k++) {
          const pt = rnd() < (g === 'F' ? c.ptW : c.ptM);
          const hours = pt ? [20, 24, 25, 30, 32][Math.floor(rnd() * 5)] : 40;
          const full = c.base * (g === 'F' ? c.wBase : 1) * Math.exp(gauss() * c.sd);
          const base = Math.round(full * hours / 40 / 10) * 10;
          const [share, amt] = g === 'F' ? c.varW : c.varM;
          const bonus = rnd() < share ? Math.round(amt * Math.exp(gauss() * 0.3) * Math.sqrt(hours / 40) / 10) * 10 : 0;
          rows.push(['E' + (id++), g === 'F' ? 'F' : 'M', c.name, String(hours), String(base), String(bonus)]);
        }
      }
    }
    // two colleagues recorded with another gender marker, to show how they are handled
    rows[EXAMPLE_X[0]][1] = 'X'; rows[EXAMPLE_X[1]][1] = 'X';
    // shuffle so the file is not sorted by category and gender
    for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
    return { delimiter: ',', headers: ['Employee ID', 'Gender', 'Job category', 'Weekly hours', 'Annual base salary', 'Bonus and allowances'], rows, rowNums: rows.map((_, i) => i + 2) };
  }
  const EXAMPLE_SEED = 20270607;
  const EXAMPLE_X = [57, 210];
  const EXAMPLE_CATS = [
    { name: 'Warehouse operatives',        w: 34, m: 80, base: 29500, sd: 0.050, wBase: 0.990, varM: [0.60, 1900], varW: [0.45, 1500], ptW: 0.30, ptM: 0.06 },
    { name: 'Drivers',                     w: 8,  m: 58, base: 33800, sd: 0.045, wBase: 0.985, varM: [0.80, 2600], varW: [0.72, 2200], ptW: 0.20, ptM: 0.05 },
    { name: 'Maintenance technicians',     w: 3,  m: 23, base: 39500, sd: 0.050, wBase: 0.970, varM: [0.50, 1600], varW: [0.40, 1400], ptW: 0.00, ptM: 0.04 },
    { name: 'Customer service agents',     w: 40, m: 15, base: 31200, sd: 0.045, wBase: 1.010, varM: [0.35, 1100], varW: [0.35, 1100], ptW: 0.45, ptM: 0.13 },
    { name: 'Dispatch and planning',       w: 18, m: 21, base: 36400, sd: 0.050, wBase: 0.985, varM: [0.40, 1300], varW: [0.35, 1200], ptW: 0.30, ptM: 0.05 },
    { name: 'Sales and account management', w: 13, m: 22, base: 44000, sd: 0.060, wBase: 0.965, varM: [0.86, 9800], varW: [0.77, 6000], ptW: 0.23, ptM: 0.05 },
    { name: 'Finance and administration',  w: 21, m: 9,  base: 42500, sd: 0.050, wBase: 1.015, varM: [0.35, 1300], varW: [0.35, 1300], ptW: 0.38, ptM: 0.10 },
    { name: 'IT and systems',              w: 6,  m: 14, base: 52000, sd: 0.060, wBase: 0.975, varM: [0.45, 2200], varW: [0.40, 2000], ptW: 0.17, ptM: 0.07 },
    { name: 'Team leaders and supervisors', w: 10, m: 17, base: 47500, sd: 0.045, wBase: 0.955, varM: [0.72, 3900], varW: [0.60, 2500], ptW: 0.20, ptM: 0.00 },
  ];
  function tableToCsv(t) { return [t.headers].concat(t.rows).map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }

  return { detectDelimiter, parseDelimited, toTable, cleanNum, inferDecimal, parseNumber, norm, headerScore, guessGender, guessMapping, distinct,
    mean, median, gapPct, isFlag, FLAG_AT, WEEKS, buildWorkers, quartileBands, computeBasis, qualityNotes, reportingClock,
    fmtDate, fmtNum, fmtInt, fmtGap, fmtPct, fmtMoney, fmtCount, csvCell, categoryCsv, summaryText, exampleTable, tableToCsv, EXAMPLE_NAME, MONTHS };
})();
