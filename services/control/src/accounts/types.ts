export type Role = "admin" | "facilitator";
export type Status = "invited" | "active" | "revoked";
/** Salted scrypt hash, both parts base64url. */
export type PasswordHash = { salt: string; hash: string };

export type Account = {
  id: string;
  login: string;
  name: string;
  role: Role;
  status: Status;
  password: PasswordHash;
  mustChange: boolean;
  tempExpiresAt: number | null;
  epoch: number;
  createdAt: number;
  createdBy: string | null;
};

export type PublicAccount = Omit<Account, "password">;
export type AccountsFile = { legacyClosed: boolean; accounts: Account[] };
