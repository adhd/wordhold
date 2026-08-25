declare module "turndown" {
  export interface TurndownOptions {
    headingStyle?: string;
    codeBlockStyle?: string;
    bulletListMarker?: string;
    emDelimiter?: string;
    hr?: string;
  }

  export default class TurndownService {
    constructor(options?: TurndownOptions);
    remove(filter: string | string[]): this;
    turndown(input: string): string;
  }
}
