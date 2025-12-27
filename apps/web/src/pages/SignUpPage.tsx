import { SignUp } from "@clerk/clerk-react";
import { useSearchParams } from "react-router-dom";

export default function SignUpPage() {
  const [params] = useSearchParams();
  const plan = params.get("plan");
  const afterSignUpUrl = plan
    ? `/pricing?onboarding=1&plan=${plan}`
    : "/pricing?onboarding=1";

  return <SignUp routing="path" path="/signup" afterSignUpUrl={afterSignUpUrl} />;
}

