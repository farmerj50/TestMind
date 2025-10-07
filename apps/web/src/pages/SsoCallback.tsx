// apps/web/src/pages/SsoCallback.tsx
import { AuthenticateWithRedirectCallback } from "@clerk/clerk-react";
export default function SsoCallback() {
  return <AuthenticateWithRedirectCallback />;
}
