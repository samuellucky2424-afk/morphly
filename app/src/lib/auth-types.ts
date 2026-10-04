export interface AuthUser {
  id:string;
  email?:string;
  created_at:string;
  user_metadata:Record<string,any>;
  app_metadata:Record<string,any>;
  aud:string;
  identities?:Array<{provider:string}>;
}
export interface AuthSession {
  access_token:string;
  user:AuthUser;
  token_type:string;
  expires_in:number;
  refresh_token:string;
}
