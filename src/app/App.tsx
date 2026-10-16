/**
 * Routing table.
 *
 * The graph explorer and the mentor pull in cytoscape and the full engine, so
 * they are lazy-loaded: the landing page and the dashboard stay small and fast,
 * which matters most on a phone and on a slow connection.
 */
import { Suspense, lazy, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'

import { Layout } from './Layout.tsx'
import { Loading } from '@/components/ui.tsx'
import { useAppStore } from '@/state/store.ts'

import { LandingPage } from '@/features/landing/LandingPage.tsx'
import { OnboardingPage } from '@/features/onboarding/OnboardingPage.tsx'
import { DashboardPage } from '@/features/dashboard/DashboardPage.tsx'
import { CareersPage } from '@/features/careers/CareersPage.tsx'
import { CareerDetailPage } from '@/features/careers/CareerDetailPage.tsx'
import { SkillDetailPage } from '@/features/skills/SkillDetailPage.tsx'
import { SkillsIndexPage } from '@/features/skills/SkillsIndexPage.tsx'
import { NotFoundPage } from '@/features/misc/NotFoundPage.tsx'
import { AuthPage, ResetLanding } from '@/features/auth/AuthPage.tsx'
import { AboutPage } from '@/features/misc/AboutPage.tsx'
import { PrivacyPage } from '@/features/misc/PrivacyPage.tsx'

const GraphPage = lazy(() => import('@/features/graph/GraphPage.tsx').then((module) => ({ default: module.GraphPage })))
const PathwayPage = lazy(() => import('@/features/roadmap/PathwayPage.tsx').then((module) => ({ default: module.PathwayPage })))
const RoadmapPage = lazy(() => import('@/features/roadmap/RoadmapPage.tsx').then((module) => ({ default: module.RoadmapPage })))
const GapsPage = lazy(() => import('@/features/gaps/GapsPage.tsx').then((module) => ({ default: module.GapsPage })))
const ProjectsPage = lazy(() => import('@/features/projects/ProjectsPage.tsx').then((module) => ({ default: module.ProjectsPage })))
const ResourcesPage = lazy(() => import('@/features/resources/ResourcesPage.tsx').then((module) => ({ default: module.ResourcesPage })))
const MentorPage = lazy(() => import('@/features/mentor/MentorPage.tsx').then((module) => ({ default: module.MentorPage })))
const ProgressPage = lazy(() => import('@/features/progress/ProgressPage.tsx').then((module) => ({ default: module.ProgressPage })))
const SettingsPage = lazy(() => import('@/features/settings/SettingsPage.tsx').then((module) => ({ default: module.SettingsPage })))
/* The workflow page pulls the engine, the library and the n8n export, so it is
   lazy for the same reason the graph explorer is: the landing page should not
   pay for a page most visitors will never open. */
const WorkflowsPage = lazy(() => import('@/features/workflows/WorkflowsPage.tsx').then((module) => ({ default: module.WorkflowsPage })))
/* The public-API catalogue imports an 84 KB generated module, so it is lazy for
   the same reason: nobody should pay for 259 imported rows to read the landing
   page.
   Note the path: `/apis` starts with `/api`, which `vite.config.ts` proxies to the
   Edge Functions, so the dev server answered it with a 500 from a backend that is
   not running. The route is `/public-apis` and
   `tests/unit/route-collisions.test.ts` refuses to let that happen again. */
const ApisPage = lazy(() => import('@/features/apis/ApisPage.tsx').then((module) => ({ default: module.ApisPage })))

function Lazy({ children }: { children: ReactNode }): ReactNode {
  return <Suspense fallback={<Loading label="Loading this view…" />}>{children}</Suspense>
}

/** First-run routing: send new visitors to onboarding, everyone else to the dashboard. */
function HomeRoute({ children }: { children: ReactNode }): ReactNode {
  const onboarded = useAppStore((state) => state.profile.onboardedAt !== null)
  return onboarded ? <>{children}</> : <Navigate to="/onboarding" replace />
}

export function App(): ReactNode {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<LandingPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        {/* Accounts live outside the onboarding gate: someone sent a reset link
            must be able to land here without being pushed into a wizard. */}
        <Route path="/login" element={<AuthPage />} />
        <Route path="/account" element={<AuthPage />} />
        <Route path="/reset-password" element={<ResetLanding />} />
        <Route
          path="/dashboard"
          element={
            <HomeRoute>
              <DashboardPage />
            </HomeRoute>
          }
        />
        <Route path="/careers" element={<CareersPage />} />
        <Route path="/careers/:careerId" element={<CareerDetailPage />} />
        <Route path="/skills" element={<SkillsIndexPage />} />
        <Route path="/skills/:skillId" element={<SkillDetailPage />} />
        <Route
          path="/graph"
          element={
            <Lazy>
              <GraphPage />
            </Lazy>
          }
        />
        <Route
          path="/pathway"
          element={
            <Lazy>
              <PathwayPage />
            </Lazy>
          }
        />
        <Route
          path="/gaps"
          element={
            <Lazy>
              <GapsPage />
            </Lazy>
          }
        />
        <Route
          path="/roadmap"
          element={
            <Lazy>
              <RoadmapPage />
            </Lazy>
          }
        />
        <Route
          path="/projects"
          element={
            <Lazy>
              <ProjectsPage />
            </Lazy>
          }
        />
        <Route
          path="/resources"
          element={
            <Lazy>
              <ResourcesPage />
            </Lazy>
          }
        />
        <Route
          path="/mentor"
          element={
            <Lazy>
              <MentorPage />
            </Lazy>
          }
        />
        <Route
          path="/progress"
          element={
            <Lazy>
              <ProgressPage />
            </Lazy>
          }
        />
        <Route
          path="/settings"
          element={
            <Lazy>
              <SettingsPage />
            </Lazy>
          }
        />
        <Route
          path="/workflows"
          element={
            <Lazy>
              <WorkflowsPage />
            </Lazy>
          }
        />
        <Route
          path="/public-apis"
          element={
            <Lazy>
              <ApisPage />
            </Lazy>
          }
        />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}


