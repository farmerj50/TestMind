// apps/web/src/pages/SignInPage.tsx
import { SignIn } from "@clerk/clerk-react";
import { useSearchParams } from "react-router-dom";

export default function SignInPage() {
  const [params] = useSearchParams();
  const redirect = params.get("redirect") ?? "/dashboard";

  return (
    <div className="min-h-screen grid place-items-center p-6">
      <SignIn
        routing="path"
        path="/signin"
        fallbackRedirectUrl={redirect}   // replaces deprecated afterSignInUrl
      />
    </div>
  );
}
