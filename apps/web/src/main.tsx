import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { Layout } from './components/Layout.tsx';
import './index.css';
import { ProjectPage } from './pages/ProjectPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { ResearchPage } from './pages/ResearchPage.tsx';
import { ScriptPage } from './pages/ScriptPage.tsx';
import { StoryboardPage } from './pages/StoryboardPage.tsx';
import { StoryPage } from './pages/StoryPage.tsx';
import { VisualProfilesPage } from './pages/VisualProfilesPage.tsx';
import { VoicePage } from './pages/VoicePage.tsx';
import { VoiceProfilesPage } from './pages/VoiceProfilesPage.tsx';
import { WritingPage } from './pages/WritingPage.tsx';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Layout>
          <Routes>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route path="/projects/:id/research" element={<ResearchPage />} />
            <Route path="/projects/:id/story" element={<StoryPage />} />
            <Route path="/projects/:id/script" element={<ScriptPage />} />
            <Route path="/projects/:id/voice" element={<VoicePage />} />
            <Route path="/projects/:id/storyboard" element={<StoryboardPage />} />
            <Route path="/writing" element={<WritingPage />} />
            <Route path="/voice-profiles" element={<VoiceProfilesPage />} />
            <Route path="/voice-profiles/:id" element={<VoiceProfilesPage />} />
            <Route path="/visual-profiles" element={<VisualProfilesPage />} />
            <Route path="/visual-profiles/:id" element={<VisualProfilesPage />} />
            <Route path="*" element={<p className="text-stone-500">Page not found.</p>} />
          </Routes>
        </Layout>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
