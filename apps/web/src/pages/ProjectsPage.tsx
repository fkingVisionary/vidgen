import { LANGUAGE_CODES, SUPPORTED_LANGUAGES, type LanguageCode } from '@docengine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../api.ts';
import { StatusBadge } from '../components/badges.tsx';
import { ProgressBar } from '../components/StagePipeline.tsx';
import { formatDate, formatRuntime } from '../format.ts';

export function ProjectsPage() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, refetchInterval: 10_000 });
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700"
        >
          {showForm ? 'Cancel' : 'New project'}
        </button>
      </div>

      {showForm && <NewProjectForm />}

      {projects.isError && <p className="text-sm text-red-700">Could not load projects: {projects.error.message}</p>}
      {projects.data?.length === 0 && <p className="text-sm text-stone-500">No projects yet.</p>}
      {projects.data && projects.data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-stone-200 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Progress</th>
                <th className="px-4 py-2 font-medium">Runtime</th>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {projects.data.map((p) => (
                <tr key={p.id} className="hover:bg-stone-50">
                  <td className="px-4 py-3">
                    <Link to={`/projects/${p.slug}`} className="font-medium text-stone-900 hover:underline">
                      {p.title}
                    </Link>
                    {p.workingTitle && <div className="text-xs text-stone-500">{p.workingTitle}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="px-4 py-3">
                    <ProgressBar value={p.progress} />
                  </td>
                  <td className="px-4 py-3 text-stone-600">{formatRuntime(p)}</td>
                  <td className="px-4 py-3 text-stone-600">{formatDate(p.createdAt)}</td>
                  <td className="px-4 py-3 text-stone-600">{formatDate(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewProjectForm() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    title: '',
    workingTitle: '',
    topic: '',
    category: 'Economic History',
    targetMinutesMin: 10,
    targetMinutesMax: 15,
    masterLanguage: 'en' as LanguageCode,
  });
  const create = useMutation({
    mutationFn: () =>
      api.createProject({ ...form, workingTitle: form.workingTitle || undefined, category: form.category || undefined }),
    onSuccess: (p) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void navigate(`/projects/${p.slug}`);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  const input = 'mt-1 w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm';

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-2">
      <label className="text-sm">
        Title
        <input required className={input} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="South Sea Bubble" />
      </label>
      <label className="text-sm">
        Working title
        <input className={input} value={form.workingTitle} onChange={(e) => setForm({ ...form, workingTitle: e.target.value })} />
      </label>
      <label className="text-sm sm:col-span-2">
        Topic
        <input required className={input} value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} placeholder="What the documentary is about, in one sentence" />
      </label>
      <label className="text-sm">
        Category
        <input className={input} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
      </label>
      <div className="grid grid-cols-3 gap-2">
        <label className="text-sm">
          Min (min)
          <input type="number" min={1} max={180} className={input} value={form.targetMinutesMin} onChange={(e) => setForm({ ...form, targetMinutesMin: Number(e.target.value) })} />
        </label>
        <label className="text-sm">
          Max (min)
          <input type="number" min={1} max={180} className={input} value={form.targetMinutesMax} onChange={(e) => setForm({ ...form, targetMinutesMax: Number(e.target.value) })} />
        </label>
        <label className="text-sm">
          Master language
          <select className={input} value={form.masterLanguage} onChange={(e) => setForm({ ...form, masterLanguage: e.target.value as LanguageCode })}>
            {LANGUAGE_CODES.map((code) => (
              <option key={code} value={code}>
                {SUPPORTED_LANGUAGES[code]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button disabled={create.isPending} className="rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50">
          {create.isPending ? 'Creating…' : 'Create project'}
        </button>
        {create.isError && <span className="text-sm text-red-700">{create.error.message}</span>}
      </div>
    </form>
  );
}
