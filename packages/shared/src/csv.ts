import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { studentSchema, safeCsvCell } from "./index";
export function parseStudents(text: string) {
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024)
    throw new Error("CSV exceeds 2 MB.");
  if (text.includes("\uFFFD") || text.includes("\0"))
    throw new Error("CSV must be valid UTF-8 text.");
  const rows = parse(text, {
    bom: true,
    skip_empty_lines: true,
    columns: (headers: string[]) => {
      const normalized = headers.map((h) => h.trim().toLowerCase());
      if (
        new Set(normalized).size !== normalized.length ||
        !["id", "name", "lastname"].every((h) => normalized.includes(h))
      )
        throw new Error(
          "Required CSV columns: id, name, lastname. Column names must be unique.",
        );
      return normalized;
    },
    max_record_size: 10000,
  }) as Record<string, string>[];
  if (rows.length > 10000) throw new Error("CSV exceeds 10,000 rows.");
  if (!rows.length) throw new Error("CSV has no student rows.");
  const seen = new Set<string>();
  const valid: ReturnType<typeof studentSchema.parse>[] = [];
  const errors: { row: number; message: string }[] = [];
  rows.forEach((r, i) => {
    const parsed = studentSchema.safeParse({
      studentId: r.id,
      name: r.name,
      lastname: r.lastname,
    });
    if (!parsed.success)
      errors.push({
        row: i + 2,
        message: parsed.error.issues
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join("; "),
      });
    else if (seen.has(parsed.data.studentId))
      errors.push({
        row: i + 2,
        message: `Duplicate student ID: ${parsed.data.studentId}`,
      });
    else {
      seen.add(parsed.data.studentId);
      valid.push(parsed.data);
    }
  });
  return { rows: valid, errors };
}
export function exportStudents(
  rows: { studentId: string; name: string; lastname: string }[],
) {
  return stringify(
    rows.map((r) => [r.studentId, r.name, r.lastname].map(safeCsvCell)),
    { header: true, columns: ["id", "name", "lastname"] },
  );
}
