const SECRET_PATTERNS = [
  /<private>[\s\S]*?<\/private>/gi, // XML-style private blocks
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI keys
  /ghp_[A-Za-z0-9]{36}/g, // GitHub PAT
  /AKIA[A-Z0-9]{16}/g, // AWS access key
  /-----BEGIN [A-Z ]+ KEY-----[\s\S]+?-----END [A-Z ]+ KEY-----/g, // PEM keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /[A-Za-z0-9+/]{40,}={0,2}/g, // base64-like (high entropy)
];

export function stripPrivate(text: string): string {
  let result = text;

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }

  return result;
}
