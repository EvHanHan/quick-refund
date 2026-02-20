export class FlowError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "FlowError";
    this.code = code;
    this.details = details;
  }
}

export function toSafeError(error, fallbackCode = "UNKNOWN") {
  if (error && typeof error === "object" && "code" in error) {
    return {
      code: error.code,
      message: error.message || "Unknown flow error",
      details: error.details || ""
    };
  }

  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    details: ""
  };
}
