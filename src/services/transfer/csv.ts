// Leitura e escrita de CSV (RFC 4180) para a importação e a exportação
//  • Campos entre aspas com vírgulas, ponto e vírgula, quebras de linha e aspas duplicadas ("")
//  • BOM UTF-8 no início, finais de linha CRLF, LF ou CR
//  • Separador detectado automaticamente: vírgula, ponto e vírgula (Excel em pt-BR) ou tabulação
//  • Limites de linhas e de tamanho de campo: um arquivo malicioso não consegue travar o app
//  • Na escrita, fórmulas (=, +, -, @, tab, CR) são neutralizadas com um apóstrofo (injeção de CSV/DDE)

export class CsvError extends Error {}

export interface CsvLimits {
  /** Linhas de dados (sem contar o cabeçalho). */
  maxRows: number;
  /** Caracteres por campo. */
  maxField: number;
  /** Colunas por linha. */
  maxColumns: number;
}

export const DEFAULT_CSV_LIMITS: CsvLimits = { maxRows: 5000, maxField: 20000, maxColumns: 64 };

const CANDIDATES = [',', ';', '\t'];

/** Conta o separador fora das aspas na primeira linha lógica (o cabeçalho). */
function countOutsideQuotes(line: string, sep: string): number {
  let n = 0;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === sep && !quoted) n++;
  }
  return n;
}

function firstLogicalLine(text: string): string {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if ((ch === '\n' || ch === '\r') && !quoted) return text.slice(0, i);
  }
  return text;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Separador mais frequente no cabeçalho (vírgula em caso de empate). */
export function detectDelimiter(text: string): string {
  const header = firstLogicalLine(stripBom(text));
  let best = ',';
  let bestCount = 0;
  for (const sep of CANDIDATES) {
    const c = countOutsideQuotes(header, sep);
    if (c > bestCount) {
      best = sep;
      bestCount = c;
    }
  }
  return best;
}

/** Estado da leitura: separado do laço para manter a complexidade baixa e o código legível. */
class CsvReader {
  rows: string[][] = [];
  private row: string[] = [];
  private field = '';
  private touched = false;
  quoted = false;
  private atFieldStart = true;

  constructor(private readonly sep: string, private readonly limits: CsvLimits) {}

  addChar(ch: string) {
    this.field += ch;
    this.touched = true;
    if (this.field.length > this.limits.maxField) {
      throw new CsvError(`Um campo da linha ${this.rows.length + 1} passa de ${this.limits.maxField} caracteres`);
    }
  }

  endField() {
    this.row.push(this.field);
    this.field = '';
    if (this.row.length > this.limits.maxColumns) throw new CsvError(`A linha ${this.rows.length + 1} tem colunas demais`);
  }

  endRow() {
    this.endField();
    // Linhas totalmente vazias (ex.: linha em branco no fim do arquivo) são ignoradas
    const empty = this.row.length === 1 && this.row[0] === '' && !this.touched;
    if (!empty) {
      this.rows.push(this.row);
      if (this.rows.length > this.limits.maxRows + 1) throw new CsvError(`O arquivo passa do limite de ${this.limits.maxRows} linhas`);
    }
    this.row = [];
    this.touched = false;
  }

  /** Dentro de um campo entre aspas. Devolve a próxima posição. */
  stepQuoted(text: string, i: number): number {
    const ch = text[i];
    if (ch === '"' && text[i + 1] === '"') {
      this.addChar('"');
      return i + 2;
    }
    if (ch === '"') this.quoted = false;
    else this.addChar(ch);
    return i + 1;
  }

  /**
   * Fora das aspas. Aspas só abrem um campo citado no início do campo; no meio de um campo sem aspas, elas são
   * mantidas como caractere comum (exportações "frouxas").
   */
  stepPlain(text: string, i: number): number {
    const ch = text[i];
    if (ch === '"' && this.atFieldStart) {
      this.quoted = true;
      this.atFieldStart = false;
      this.touched = true;
    } else if (ch === this.sep) {
      this.endField();
      this.atFieldStart = true;
    } else if (ch === '\r' || ch === '\n') {
      this.endRow();
      this.atFieldStart = true;
      if (ch === '\r' && text[i + 1] === '\n') return i + 2;
    } else {
      this.addChar(ch);
      this.atFieldStart = false;
    }
    return i + 1;
  }

  get pending(): boolean {
    return this.touched || this.field !== '' || this.row.length > 0;
  }
}

/** Converte o texto em linhas de campos (RFC 4180, com as tolerâncias descritas no topo do arquivo). */
export function parseCsv(input: string, opts: { delimiter?: string; limits?: Partial<CsvLimits> } = {}): string[][] {
  const text = stripBom(input);
  const sep = opts.delimiter || detectDelimiter(text);
  const r = new CsvReader(sep, { ...DEFAULT_CSV_LIMITS, ...opts.limits });
  let i = 0;
  while (i < text.length) i = r.quoted ? r.stepQuoted(text, i) : r.stepPlain(text, i);
  if (r.quoted) throw new CsvError('Há aspas sem fechamento no arquivo');
  if (r.pending) r.endRow();
  return r.rows;
}

/** Linhas → objetos indexados pelo cabeçalho normalizado (minúsculas, sem espaços nas pontas). */
export function rowsToRecords(rows: string[][]): { header: string[]; records: Record<string, string>[] } {
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const records = rows.slice(1).map(r => {
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => {
      if (h) rec[h] = r[idx] ?? '';
    });
    return rec;
  });
  return { header, records };
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

/** Caracteres que fazem uma planilha interpretar a célula como fórmula (OWASP: CSV Injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Neutraliza fórmulas prefixando um apóstrofo. O apóstrofo também é prefixado em valores que já começam
 * com ele, para a operação ser reversível na reimportação (`restoreFormula`).
 */
export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) || value.startsWith("'") ? `'${value}` : value;
}

/** Desfaz `neutralizeFormula` (usado só ao reimportar um CSV exportado pelo próprio Custódia). */
export function restoreFormula(value: string): string {
  return value.startsWith("'") ? value.slice(1) : value;
}

function quoteField(value: string, sep: string): string {
  if (value.includes('"') || value.includes(sep) || value.includes('\n') || value.includes('\r') || /^\s|\s$/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Gera CSV com CRLF (padrão RFC 4180, abre direto no Excel/Planilhas) e fórmulas neutralizadas. */
export function toCsv(header: string[], rows: (string | number | boolean | null | undefined)[][], sep = ','): string {
  const line = (cells: (string | number | boolean | null | undefined)[]) =>
    cells.map(c => quoteField(neutralizeFormula(c == null ? '' : String(c)), sep)).join(sep);
  return [line(header), ...rows.map(line)].join('\r\n') + '\r\n';
}
