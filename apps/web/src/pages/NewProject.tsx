import { useState } from 'react';
import { useAuth } from '@clerk/clerk-react';

const API = import.meta.env.VITE_API_URL as string;

export default function NewProjectPage() {
  const [name, setName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const { getToken } = useAuth();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);

    const payload: Record<string, string> = { name: name.trim() };
    const trimmedRepo = repoUrl.trim();
    if (trimmedRepo) payload.repoUrl = trimmedRepo;

    const token = await getToken(); // Clerk session token (JWT)
    const res = await fetch(`${API}/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token ?? ''}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setStatus(`Error: ${res.status} ${JSON.stringify(err)}`);
      return;
    }

    const created = await res.json();
    setStatus(`Created project: ${created.name}`);
    setName('');
    setRepoUrl('');
  }

  return (
    <div className="mx-auto max-w-md p-6">
      <h1 className="text-xl font-bold">Create a project</h1>
      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <input
          className="w-full rounded-md border px-3 py-2"
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="w-full rounded-md border px-3 py-2"
          placeholder="Repo URL (https://...)"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
        />
        <button className="w-full rounded-md bg-slate-900 px-3 py-2 text-white">
          Create
        </button>
      </form>
      {status && <div className="mt-3 text-sm text-slate-600">{status}</div>}
    </div>
  );
}
