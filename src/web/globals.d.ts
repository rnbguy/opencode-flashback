declare const marked: {
  setOptions(options: Record<string, unknown>): void;
  parse(markdown: string): string;
};

declare const DOMPurify: {
  sanitize(html: string): string;
};

declare const lucide: {
  createIcons(): void;
};

declare function jsonrepair(json: string): string;
