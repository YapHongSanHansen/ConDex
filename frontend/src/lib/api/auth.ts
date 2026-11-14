import { request } from "./client";
import type { AuthApi } from "./types";

export const authApi: AuthApi = {
  challenge: () => request("/v1/auth/challenge", { method: "POST" }),
  verify: (body) => request("/v1/auth/verify", { method: "POST", body }),
  logout: () => request("/v1/auth/logout", { method: "POST" }),
  me: () => request("/v1/me"),
};
