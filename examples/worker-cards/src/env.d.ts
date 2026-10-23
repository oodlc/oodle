// The few Workers types this example uses. A real project has @cloudflare/workers-types.
declare module 'cloudflare:workers' {
  export const env: Record<string, any>;
}
declare module 'cloudflare:email' {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string);
  }
}
declare module '*.md' {
  const text: string;
  export default text;
}
interface HTMLRewriterElement {
  append(content: string, options?: { html?: boolean }): void;
}
declare class HTMLRewriter {
  on(selector: string, handlers: { element(el: HTMLRewriterElement): void }): this;
  transform(response: Response): Response;
}
interface SubtleCrypto {
  timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean;
}
