// apps/web/src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { ClerkProvider } from "@clerk/clerk-react";
import AppRoutes from "./routes/AppRoutes";
import "./index.css";
import { Toaster } from "sonner";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!PUBLISHABLE_KEY) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in your environment.");
}

function ClerkWithRouter() {
  const navigate = useNavigate();

  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      // Use React Router for Clerk navigation
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
      // Keep paths consistent with your app
      signInUrl="/signin"
      signUpUrl="/signup"
      // If you ever want sign-out to go home instead of /signin:
      // afterSignOutUrl="/"
    >
      <AppRoutes />
    </ClerkProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ClerkWithRouter />
      <Toaster richColors position="top-center" />
    </BrowserRouter>
  </React.StrictMode>
);
