import ISO6391 from "iso-639-1";
import { detect } from "tinyld/light";

export interface LanguageDetectionResult {
  mode: "code" | "nl" | "mixed";
  codeRatio: number;
  detectedLang?: string;
}

const MAX_ANALYZED_CHARS = 4096;

export async function detectLanguage(
  text: string,
): Promise<LanguageDetectionResult> {
  if (!text || text.trim().length === 0) {
    return { mode: "nl", codeRatio: 0, detectedLang: "en" };
  }

  const analyzed =
    text.length > MAX_ANALYZED_CHARS ? text.slice(0, MAX_ANALYZED_CHARS) : text;

  // Count code-like patterns
  const camelCaseMatches = (analyzed.match(/[a-z]+[A-Z]/g) || []).length;
  const snakeCaseMatches = (analyzed.match(/_[a-z]/g) || []).length;
  const symbolChars = (analyzed.match(/[{}<>()[\]]/g) || []).length;
  const codeIndicators = camelCaseMatches + snakeCaseMatches + symbolChars;

  const codeRatio = codeIndicators / analyzed.length;

  // High code ratio -- skip language detection
  if (codeRatio > 0.3) {
    return { mode: "code", codeRatio };
  }

  // Low code ratio + sufficient text -- detect language
  if (codeRatio < 0.1 && analyzed.length > 50) {
    try {
      const detectedLang = detect(analyzed);
      return {
        mode: "nl",
        codeRatio,
        detectedLang: detectedLang || "en",
      };
    } catch {
      // language detection failed -- fall back to English defaults
      return { mode: "nl", codeRatio, detectedLang: "en" };
    }
  }

  // Mixed mode
  return { mode: "mixed", codeRatio, detectedLang: "en" };
}

export function getLanguageName(code: string): string {
  return ISO6391.getName(code) || "English";
}
