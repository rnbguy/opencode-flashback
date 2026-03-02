import { detect } from "tinyld/light";

export interface LanguageDetectionResult {
  mode: "code" | "nl" | "mixed";
  codeRatio: number;
  detectedLang?: string;
}

export async function detectLanguage(
  text: string,
): Promise<LanguageDetectionResult> {
  if (!text || text.trim().length === 0) {
    return { mode: "nl", codeRatio: 0, detectedLang: "en" };
  }

  // Count code-like patterns
  const camelCaseMatches = (text.match(/[a-z]+[A-Z]/g) || []).length;
  const snakeCaseMatches = (text.match(/_[a-z]/g) || []).length;
  const symbolChars = (text.match(/[{}<>()[\]]/g) || []).length;
  const codeIndicators = camelCaseMatches + snakeCaseMatches + symbolChars;

  const codeRatio = codeIndicators / text.length;

  // High code ratio → skip language detection
  if (codeRatio > 0.3) {
    return { mode: "code", codeRatio };
  }

  // Low code ratio + sufficient text → detect language
  if (codeRatio < 0.1 && text.length > 50) {
    try {
      const detectedLang = detect(text);
      return {
        mode: "nl",
        codeRatio,
        detectedLang: detectedLang || "en",
      };
    } catch {
      return { mode: "nl", codeRatio, detectedLang: "en" };
    }
  }

  // Mixed mode
  return { mode: "mixed", codeRatio, detectedLang: "en" };
}
