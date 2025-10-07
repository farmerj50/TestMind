export default function ResetPage() {
  return (
    <div className="min-h-screen grid place-items-center p-8">
      <div className="w-full max-w-sm rounded-2xl border bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold">Reset password</h1>
        <form className="mt-4 space-y-3">
          <input className="w-full rounded-md border px-3 py-2" type="email" placeholder="you@company.com" />
          <button className="w-full rounded-md bg-slate-900 px-3 py-2 text-white">Send reset link</button>
        </form>
      </div>
    </div>
  );
}