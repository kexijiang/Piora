export interface VaultEntry { id: string; name: string; url: string; username: string; password: string; notes: string; group: string }
export type VaultMetadata = Omit<VaultEntry, "password">;
export interface VaultSnapshot { available: boolean; initialized: boolean; unlocked: boolean; autofill: boolean; entries: VaultMetadata[]; audit: Array<{ id: string; name: string; origin: string; at: number }> }
export interface VaultRequest { action: "status" | "initialize" | "unlock" | "lock" | "save" | "remove" | "configure" | "export" | "import" | "fill" | "release"; password?: string; enabled?: boolean; id?: string; entry?: Partial<VaultEntry> }
export interface VaultBridge { request(input: VaultRequest): Promise<VaultSnapshot> }
