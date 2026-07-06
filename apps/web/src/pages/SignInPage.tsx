// apps/web/src/pages/SignInPage.tsx
import { SignIn, useAuth } from "@clerk/clerk-react";
import { Navigate, useSearchParams } from "react-router-dom";

export default function SignInPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const [params] = useSearchParams();
  const redirect = params.get("redirect") ?? "/dashboard";

  if (!isLoaded) return null;
  if (isSignedIn) return <Navigate to={redirect} replace />;

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
