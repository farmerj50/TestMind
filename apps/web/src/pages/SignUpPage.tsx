import { SignUp, useAuth } from "@clerk/clerk-react";
import { Navigate, useSearchParams } from "react-router-dom";

export default function SignUpPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const [params] = useSearchParams();
  const plan = params.get("plan");
  const afterSignUpUrl = plan
    ? `/pricing?onboarding=1&plan=${plan}`
    : "/pricing?onboarding=1";

  if (!isLoaded) return null;
  if (isSignedIn) return <Navigate to={afterSignUpUrl} replace />;

  return <SignUp routing="path" path="/signup" afterSignUpUrl={afterSignUpUrl} />;
}
