export class ToolError extends Error {
  public readonly code: string;
  public readonly toolName: string;
  public readonly statusCode: number;

  constructor(opts: {
    message: string;
    code: string;
    toolName: string;
    statusCode?: number;
  }) {
    super(opts.message);
    this.name = "ToolError";
    this.code = opts.code;
    this.toolName = opts.toolName;
    this.statusCode = opts.statusCode ?? 400;
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      tool: this.toolName,
    };
  }
}

export function isToolError(err: unknown): err is ToolError {
  return err instanceof ToolError;
}
