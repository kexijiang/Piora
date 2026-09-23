export type CodeIntelligenceMode = "arkts-lsp" | "arkts-basic" | "typescript";

export interface CodeDefinition {
  filePath: string;
  line: number;
  column: number;
  name?: string;
}

export interface CodeSuggestion {
  label: string;
  insertText?: string;
  detail?: string;
  documentation?: string;
  kind?: string;
}

export interface CodeIntelligenceResult {
  mode: CodeIntelligenceMode;
  message?: string;
  definitions?: CodeDefinition[];
  suggestions?: CodeSuggestion[];
  hover?: string;
}
