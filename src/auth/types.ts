export interface PrivilegeStatus {
  view: boolean;
  add: boolean;
  edit: boolean;
  delete: boolean;
}

export interface UserPrivilege {
  name: string;
  alias: string;
  status: PrivilegeStatus;
  state?: string;
  action?: string;
  icon?: string;
  childs?: Array<{
    name: string;
    alias?: string;
    state: string;
    action: string;
  }>;
}

export interface AuthContext {
  token: string;
  username: string;
  role: string;
  countryCode: string;
  countryName: string;
  isCountryManager: boolean;
  isDispatchManager: boolean;
  privileges: UserPrivilege[];
}

export type SafetyTier = 'auto' | 'confirm' | 'always_confirm';

export type ToolSource = 'api' | 'db';

export interface PermissionRequirement {
  alias: string;
  action: keyof PrivilegeStatus;
}
