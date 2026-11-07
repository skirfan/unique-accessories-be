export function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}
