export class MobileMcpToolError extends Error {
  public override readonly name = "MobileMcpToolError";
  public readonly toolName: string;

  public constructor(toolName: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.toolName = toolName;
  }
}
