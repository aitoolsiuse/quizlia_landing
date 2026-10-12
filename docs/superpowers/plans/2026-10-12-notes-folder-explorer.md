# My Notes Folder Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the web "My Notes" tab into an iOS-style file explorer (folder tile grid → drill into folder), with a Generate Content + New Folder toolbar and a generator sheet that files new notes into the current folder.

**Architecture:** URL-driven explorer in `/note/notes` (`?folder=all|none|<id>` query param, `<Suspense>`-wrapped per this Next version's `useSearchParams` docs). The dashboard's ~190-line generation logic is extracted into `hooks/useGenerateContent.ts` + `GenerateContentForm.tsx` shared by the dashboard and a new `GenerateContentSheet` modal. No storage changes — folders stay in `localStorage folders_<profileId>`, topics via `lib/notesSync`.

**Tech Stack:** Next.js (App Router, see `node_modules/next/dist/docs/` — this version has breaking changes), React client components, Tailwind, TypeScript.

**Spec:** `docs/superpowers/specs/2026-10-12-notes-folder-explorer-design.md`

## Global Constraints

- Repo has NO test framework — verification is `npx tsc --noEmit`, `npm run lint`, `npm run build`, plus the manual browser checklist in Task 4. Do not add test infrastructure.
- Windows machine; project root `e:\Projects\Arasheed\QuickNote\quizlia_landing`. All `npm`/`npx` commands run from project root.
- Style: Tailwind utility classes matching the existing `components/app/*` components, Material Symbols icons (`<span className="material-symbols-outlined">icon_name</span>`), light+dark variants everywhere.
- Keep ALL existing modals/components working: `CreateFolderModal`, `RenameModal`, `MoveFolderModal`, `Sidebar`, `ProcessingModal`, `PaywallModal`, `useToast`.
- Do NOT touch: `lib/notesSync.ts`, `lib/subscription.ts`, Firebase anything, the iOS repo, the Public Study Guides section markup.
- Folder ids are strings (`String(Date.now())`). `Topic.folderId?: string | number`. Null folderId means Unsorted.
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

---

### Task 1: Extract the generator (hook + form + sheet) and rewire the dashboard

**Files:**
- Modify: `lib/types.ts` (append two exported interfaces at the end)
- Create: `hooks/useGenerateContent.ts`
- Create: `components/app/GenerateContentForm.tsx`
- Create: `components/app/GenerateContentSheet.tsx`
- Modify: `app/note/page.tsx` (full rewrite — shrinks from 555 to ~380 lines)

**Interfaces:**
- Produces (used by Tasks 3): `GenerateContentSheet` props `{ isOpen: boolean; onClose: () => void; profile: Profile | null; targetFolderId?: string; targetFolderName?: string; onGenerated?: (updatedContent: ContentItem[]) => void }`; `Profile` and `ContentItem` exported from `@/lib/types`.
- The hook reads existing content from `localStorage[content_<profileId>]` at generation time (not from host state), so both dashboard and sheet share one code path.

- [ ] **Step 1: Add shared types to `lib/types.ts`**

Append at the end of `lib/types.ts`:

```ts
// Profile stored in localStorage "currentProfile" and rendered by the app UI
export interface Profile {
  id: number;
  name: string;
  type: string;
  avatar: string;
  email?: string;
}

// Legacy content item stored per profile (content_<profileId>)
export interface ContentItem {
  id: number;
  title: string;
  description: string;
  type: string;
  createdAt: string;
  data?: any;
  sourceId?: string;
  sourceName?: string;
  sourceType?: string;
  folderId?: string;
}
```

- [ ] **Step 2: Create `hooks/useGenerateContent.ts`**

This is the dashboard's `generateContent`/`handleFileChange` logic ported verbatim, with three changes: (1) existing content is read from localStorage instead of component state, (2) created items get `folderId: targetFolderId`, (3) `onGenerated` callback replaces host state updates.

```ts
"use client";

import { useState } from "react";
import { useToast } from "@/components/app/ToastContainer";
import { canGenerate, incrementUsage } from "@/lib/subscription";
import { persistProfileContent } from "@/lib/notesSync";
import type { Profile, ContentItem } from "@/lib/types";

interface UseGenerateContentOptions {
  profile: Profile | null;
  /** Folder the generated notes are filed into (undefined = Unsorted) */
  targetFolderId?: string;
  onGenerated?: (updatedContent: ContentItem[]) => void;
}

export function useGenerateContent({ profile, targetFolderId, onGenerated }: UseGenerateContentOptions) {
  const { showToast } = useToast();
  const [contentType, setContentType] = useState("url");
  const [contentInput, setContentInput] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaywallOpen, setIsPaywallOpen] = useState(false);
  const [remainingGenerations, setRemainingGenerations] = useState(3);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setContentInput(file.name);
    }
  };

  const generateContent = async () => {
    if (!contentInput.trim() && !selectedFile) return;
    if (!profile) return;

    // Check usage limits
    const usageCheck = canGenerate(profile.id);
    setRemainingGenerations(usageCheck.remaining);

    if (!usageCheck.allowed) {
      setIsPaywallOpen(true);
      return;
    }

    setIsProcessing(true);
    showToast("Generating your study materials...", "info");

    try {
      const sourceText = selectedFile ? selectedFile.name : contentInput;

      let contentToAnalyze = contentInput;
      let fileData: string | null = null;
      let fileMimeType: string | null = null;

      // Prepare content based on type
      if (selectedFile) {
        if (contentType === "image" || contentType === "pdf") {
          const reader = new FileReader();
          const base64Promise = new Promise<string>((resolve, reject) => {
            reader.onload = () => {
              const base64 = (reader.result as string).split(',')[1];
              resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(selectedFile);
          });

          try {
            fileData = await base64Promise;
            fileMimeType = selectedFile.type || (contentType === "pdf" ? "application/pdf" : "image/jpeg");
            contentToAnalyze = contentType === "image"
              ? "Analyze this image and extract all relevant information."
              : "Analyze this PDF document and extract all relevant information.";
          } catch (error) {
            showToast(`Failed to read ${contentType} file`, "error");
            setIsProcessing(false);
            return;
          }
        }
      } else {
        if (contentType === "url") {
          contentToAnalyze = `Analyze the following link: ${contentInput}`;
        } else if (contentType === "youtube") {
          contentToAnalyze = `Analyze the following link: ${contentInput}`;
          fileMimeType = "video/youtube";
        }
      }

      const requestBody = {
        type: "",
        content: contentToAnalyze,
        ...(fileMimeType && { mimeType: fileMimeType }),
        ...(fileData && { fileData })
      };

      // Generate all three types in parallel
      const [noteResponse, flashcardResponse, quizResponse] = await Promise.all([
        fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...requestBody, type: "note" }),
        }),
        fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...requestBody, type: "flashcard" }),
        }),
        fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...requestBody, type: "quiz" }),
        }),
      ]);

      const [noteResult, flashcardResult, quizResult] = await Promise.all([
        noteResponse.json().catch(() => ({ success: false, message: "Failed to parse notes response" })),
        flashcardResponse.json().catch(() => ({ success: false, message: "Failed to parse flashcards response" })),
        quizResponse.json().catch(() => ({ success: false, message: "Failed to parse quiz response" })),
      ]);

      // Check for HTTP errors
      if (!noteResponse.ok || !flashcardResponse.ok || !quizResponse.ok) {
        const errorMessages = [];
        if (!noteResponse.ok) errorMessages.push(noteResult.message || noteResult.error || `Notes: HTTP ${noteResponse.status}`);
        if (!flashcardResponse.ok) errorMessages.push(flashcardResult.message || flashcardResult.error || `Flashcards: HTTP ${flashcardResponse.status}`);
        if (!quizResponse.ok) errorMessages.push(quizResult.message || quizResult.error || `Quiz: HTTP ${quizResponse.status}`);
        showToast(errorMessages[0] || "Failed to generate content. Please try again.", "error");
        return;
      }

      // Create content items
      const timestamp = Date.now();
      const sourceId = `source_${timestamp}`;
      const sourceName = sourceText.length > 50 ? sourceText.substring(0, 50) + "..." : sourceText;
      const sourceLabel = contentType.toUpperCase();

      const newItems: ContentItem[] = [];
      const errors: string[] = [];

      // Add notes
      if (noteResult.success && noteResult.data && !noteResult.data.error && noteResult.data.title) {
        newItems.push({
          id: timestamp,
          title: noteResult.data.title,
          description: `AI-generated notes from ${sourceLabel}`,
          type: "notes",
          createdAt: new Date().toISOString(),
          data: noteResult.data,
          sourceId,
          sourceName,
          sourceType: contentType,
          folderId: targetFolderId,
        });
      } else {
        errors.push(noteResult.message || "Notes generation failed");
      }

      // Add flashcards
      if (flashcardResult.success && flashcardResult.data?.flashcards?.length > 0) {
        newItems.push({
          id: timestamp + 1,
          title: `Flashcards: ${sourceText.substring(0, 30)}...`,
          description: `${flashcardResult.data.flashcards.length} flashcards`,
          type: "flashcards",
          createdAt: new Date().toISOString(),
          sourceId,
          sourceName,
          sourceType: contentType,
          data: flashcardResult.data,
          folderId: targetFolderId,
        });
      } else {
        errors.push(flashcardResult.message || "Flashcards generation failed");
      }

      // Add quiz
      if (quizResult.success && quizResult.data?.quizzes?.length > 0) {
        newItems.push({
          id: timestamp + 2,
          title: `Quiz: ${sourceText.substring(0, 30)}...`,
          description: `${quizResult.data.quizzes.length} questions`,
          type: "quiz",
          createdAt: new Date().toISOString(),
          sourceId,
          sourceName,
          sourceType: contentType,
          data: quizResult.data,
          folderId: targetFolderId,
        });
      } else {
        errors.push(quizResult.message || "Quiz generation failed");
      }

      if (newItems.length === 0) {
        showToast(errors[0] || "Failed to generate any content. Please try again.", "error");
        return;
      }

      const storedContent: ContentItem[] =
        typeof window !== "undefined"
          ? JSON.parse(localStorage.getItem(`content_${profile.id}`) || "[]")
          : [];
      const updatedContent = [...newItems, ...storedContent];

      if (typeof window !== "undefined") {
        persistProfileContent(profile, updatedContent);
      }

      // Increment usage
      incrementUsage(profile.id);
      const newUsage = canGenerate(profile.id);
      setRemainingGenerations(newUsage.remaining);

      const successCount = newItems.length;
      if (errors.length > 0) {
        showToast(`Generated ${successCount} materials, ${errors.length} failed`, "warning");
      } else {
        showToast(`Successfully generated notes, flashcards & quiz!`, "success");
      }

      setContentInput("");
      setSelectedFile(null);
      onGenerated?.(updatedContent);
    } catch (error) {
      console.error("Error generating content:", error);
      showToast("Failed to generate content. Please try again.", "error");
    } finally {
      setIsProcessing(false);
    }
  };

  return {
    contentType,
    setContentType,
    contentInput,
    setContentInput,
    selectedFile,
    setSelectedFile,
    handleFileChange,
    generateContent,
    isProcessing,
    isPaywallOpen,
    setIsPaywallOpen,
    remainingGenerations,
  };
}
```

- [ ] **Step 3: Create `components/app/GenerateContentForm.tsx`**

The dashboard's input card markup, plus the Processing/Paywall modals and the "Saving to" hint. `onGenerated` is optional so the dashboard's flow is unchanged.

```tsx
"use client";

import { ProcessingModal } from "@/components/app/ProcessingModal";
import { PaywallModal } from "@/components/app/PaywallModal";
import { useGenerateContent } from "@/hooks/useGenerateContent";
import type { Profile, ContentItem } from "@/lib/types";

interface GenerateContentFormProps {
  profile: Profile | null;
  targetFolderId?: string;
  targetFolderName?: string;
  onGenerated?: (updatedContent: ContentItem[]) => void;
}

export function GenerateContentForm({
  profile,
  targetFolderId,
  targetFolderName,
  onGenerated,
}: GenerateContentFormProps) {
  const {
    contentType,
    setContentType,
    contentInput,
    setContentInput,
    selectedFile,
    setSelectedFile,
    handleFileChange,
    generateContent,
    isProcessing,
    isPaywallOpen,
    setIsPaywallOpen,
    remainingGenerations,
  } = useGenerateContent({ profile, targetFolderId, onGenerated });

  return (
    <>
      <ProcessingModal
        isOpen={isProcessing}
        message="Analyzing your content and generating study materials..."
      />

      {targetFolderName && (
        <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 mb-4">
          <span className="material-symbols-outlined text-sm">folder</span>
          Saving to: {targetFolderName}
        </p>
      )}

      {/* Content Type Tabs */}
      <div className="flex flex-col sm:flex-row h-auto sm:h-14 w-full items-center rounded-xl bg-gray-100 dark:bg-gray-800 p-1.5 gap-2 sm:gap-1 mb-6">
        {[
          { type: "url", icon: "link", label: "URL" },
          { type: "pdf", icon: "picture_as_pdf", label: "PDF" },
          { type: "youtube", icon: "play_circle", label: "YouTube" },
          { type: "image", icon: "image", label: "Image" },
        ].map(({ type, icon, label }) => (
          <button
            key={type}
            onClick={() => setContentType(type)}
            className={`flex cursor-pointer h-full grow items-center justify-center gap-2 rounded-lg px-4 py-2 w-full text-sm font-medium transition-all ${
              contentType === type
                ? "bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-md"
                : "text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            <span className="material-symbols-outlined text-lg">{icon}</span>
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Input Field */}
      <div className="flex flex-col sm:flex-row gap-3">
        {contentType === "url" || contentType === "youtube" ? (
          <input
            type="text"
            value={contentInput}
            onChange={(e) => setContentInput(e.target.value)}
            placeholder={contentType === "url" ? "Paste URL here..." : "Paste YouTube URL here..."}
            className="flex-1 px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        ) : (
          <div className="flex-1 relative">
            <input
              type="file"
              id="file-upload"
              accept={contentType === "pdf" ? ".pdf" : "image/*"}
              onChange={handleFileChange}
              className="hidden"
            />
            <label
              htmlFor="file-upload"
              className="flex items-center justify-between w-full px-4 py-3 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white hover:border-blue-500 cursor-pointer transition-colors"
            >
              <span className="flex items-center gap-2">
                <span className="material-symbols-outlined text-gray-400">upload_file</span>
                <span className="text-sm">
                  {selectedFile ? selectedFile.name : `Click to upload ${contentType.toUpperCase()}`}
                </span>
              </span>
              {selectedFile && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    setSelectedFile(null);
                    setContentInput("");
                  }}
                  className="text-red-500 hover:text-red-700"
                >
                  <span className="material-symbols-outlined text-sm">close</span>
                </button>
              )}
            </label>
          </div>
        )}
        <button
          onClick={generateContent}
          disabled={!contentInput.trim() && !selectedFile}
          className="btn-primary px-6 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Generate
        </button>
      </div>

      <PaywallModal
        isOpen={isPaywallOpen}
        onClose={() => setIsPaywallOpen(false)}
        remainingGenerations={remainingGenerations}
        profileId={profile?.id || 0}
      />
    </>
  );
}
```

- [ ] **Step 4: Create `components/app/GenerateContentSheet.tsx`**

Modal wrapper styled like the existing `MoveFolderModal` overlay. Unmounting when closed (`if (!isOpen) return null`) resets the form state.

```tsx
"use client";

import { GenerateContentForm } from "./GenerateContentForm";
import type { Profile, ContentItem } from "@/lib/types";

interface GenerateContentSheetProps {
  isOpen: boolean;
  onClose: () => void;
  profile: Profile | null;
  targetFolderId?: string;
  targetFolderName?: string;
  onGenerated?: (updatedContent: ContentItem[]) => void;
}

export function GenerateContentSheet({
  isOpen,
  onClose,
  profile,
  targetFolderId,
  targetFolderName,
  onGenerated,
}: GenerateContentSheetProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-2xl border border-gray-200 dark:border-gray-800 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Generate Content</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="p-6">
          <GenerateContentForm
            profile={profile}
            targetFolderId={targetFolderId}
            targetFolderName={targetFolderName}
            onGenerated={onGenerated}
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Rewrite `app/note/page.tsx` (dashboard) to use the extracted form**

Replace the ENTIRE file with:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Tooltip } from "@/components/app/Tooltip";
import { Sidebar } from "@/components/app/Sidebar";
import { GenerateContentForm } from "@/components/app/GenerateContentForm";
import { useToast } from "@/components/app/ToastContainer";
import { loadProfileContent } from "@/lib/notesSync";
import { syncSubscriptionFromFirebase, createOrUpdateFirebaseUser } from "@/lib/firebaseSubscription";
import { Topic, getYouTubeThumbnail, getSourceIcon, migrateContentToTopics, ContentItem, Profile } from "@/lib/types";
import { useAuth } from "@/lib/auth";

export default function NotePage() {
  const router = useRouter();
  const { showToast } = useToast();
  const { user } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);

  useEffect(() => {
    const initializeDashboard = async () => {
      if (typeof window !== "undefined") {
        const currentProfile = localStorage.getItem("currentProfile");
        if (!currentProfile) {
          router.push("/note/profile-selection");
          return;
        }
        const profileData = JSON.parse(currentProfile);
        setProfile(profileData);

        const storedContent = localStorage.getItem(`content_${profileData.id}`);
        if (!storedContent) {
          // First visit on this device: pull content synced from other
          // devices / the iOS app, cache it, and reload once to display.
          loadProfileContent(profileData).then((cloud) => {
            if (cloud) window.location.reload();
          });
        }
        if (storedContent) {
          const parsedContent = JSON.parse(storedContent);
          setContent(parsedContent);
          setTopics(migrateContentToTopics(parsedContent));
        }
      }
    };

    initializeDashboard();
  }, [router]);

  // Sync subscription from Firebase only for signed-in users.
  // Signed-out visitors stay on localStorage and skip Firestore entirely,
  // which avoids permission-denied errors from the security rules.
  useEffect(() => {
    if (!user?.email || !profile) return;

    const email = profile.email || user.email;
    createOrUpdateFirebaseUser(email)
      .then(() => syncSubscriptionFromFirebase(email, profile.id))
      .catch((error) => console.log("Firebase sync skipped:", error));
  }, [user, profile]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffMinutes = Math.floor(diffTime / (1000 * 60));
    const diffHours = Math.floor(diffTime / (1000 * 60 * 60));
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffMinutes < 1) return "Just now";
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const handleDeleteTopic = (topicId: string) => {
    if (!profile || typeof window === "undefined") return;

    const updatedContent = content.filter((item) => item.sourceId !== topicId);
    setContent(updatedContent);
    setTopics(migrateContentToTopics(updatedContent));
    localStorage.setItem(`content_${profile.id}`, JSON.stringify(updatedContent));
    showToast("Topic deleted", "success");
  };

  if (!profile) return null;

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 overflow-hidden">
      <Sidebar profile={profile} />

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="px-4 sm:px-6 lg:px-10 py-8 w-full max-w-6xl mx-auto">
          {/* Header */}
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white mb-2">
              What do you want to learn today?
            </h1>
            <p className="text-gray-600 dark:text-gray-400">
              Generate notes, flashcards, and quizzes from any content
            </p>
          </div>

          {/* Input Section */}
          <div className="bg-white dark:bg-gray-900 rounded-xl p-6 mb-8 border border-gray-200 dark:border-gray-800">
            <GenerateContentForm
              profile={profile}
              onGenerated={(updatedContent) => {
                setContent(updatedContent);
                setTopics(migrateContentToTopics(updatedContent));
              }}
            />
          </div>

          {/* Topics Section */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Your Topics</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {topics.length} topic{topics.length !== 1 ? "s" : ""}
            </p>
          </div>

          {/* Topics Grid */}
          {topics.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {topics.map((topic) => {
                const thumbnail = topic.sourceType === "youtube" && topic.sourceUrl
                  ? getYouTubeThumbnail(topic.sourceUrl)
                  : null;

                return (
                  <div
                    key={topic.id}
                    className="group bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-sm hover:shadow-lg transition-all hover:border-blue-500 dark:hover:border-blue-500 relative overflow-hidden"
                  >
                    {/* Delete Button */}
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleDeleteTopic(topic.id);
                      }}
                      className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity bg-red-500 hover:bg-red-600 text-white rounded-full p-2 z-10 shadow-lg"
                      title="Delete topic"
                    >
                      <span className="material-symbols-outlined text-sm">delete</span>
                    </button>

                    <Link href={`/note/topic/${topic.id}`} className="block">
                      {/* YouTube Thumbnail */}
                      {thumbnail && (
                        <div className="relative h-40 bg-gray-100 dark:bg-gray-800">
                          <img
                            src={thumbnail}
                            alt="Video thumbnail"
                            className="w-full h-full object-cover"
                          />
                          <div className="absolute inset-0 bg-black/20 group-hover:bg-black/10 transition-colors" />
                        </div>
                      )}

                      <div className="p-5">
                        <div className="flex items-center gap-3 mb-3">
                          <div className="bg-purple-100 dark:bg-purple-900/30 text-purple-600 rounded-md p-1.5">
                            <span className="material-symbols-outlined">{getSourceIcon(topic.sourceType)}</span>
                          </div>
                          <span className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                            {topic.sourceType}
                          </span>
                        </div>

                        <Tooltip content={topic.title} className="block mb-3">
                          <h3 className="text-base font-semibold text-gray-900 dark:text-white line-clamp-2">
                            {topic.title}
                          </h3>
                        </Tooltip>

                        {/* Material Indicators */}
                        <div className="flex flex-wrap gap-2 mb-3">
                          {topic.note && (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                              <span className="material-symbols-outlined text-xs">description</span>
                              Notes
                            </span>
                          )}
                          {topic.flashcards && (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                              <span className="material-symbols-outlined text-xs">style</span>
                              {topic.flashcards.length} cards
                            </span>
                          )}
                          {topic.quiz && (
                            <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300">
                              <span className="material-symbols-outlined text-xs">quiz</span>
                              {topic.quiz.length} Q
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="border-t border-gray-200 dark:border-gray-800 px-5 py-3 flex justify-between items-center">
                        <span className="text-xs text-gray-600 dark:text-gray-400">
                          {formatDate(topic.createdAt)}
                        </span>
                        <span className="text-sm font-medium text-blue-600 dark:text-blue-400 flex items-center gap-1">
                          View
                          <span className="material-symbols-outlined text-sm">arrow_forward</span>
                        </span>
                      </div>
                    </Link>
                  </div>
                );
              })}
            </div>
          ) : (
            /* Empty State */
            <div className="text-center py-16 bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800">
              <div className="text-gray-400 dark:text-gray-600 mb-4">
                <span className="material-symbols-outlined text-7xl">auto_stories</span>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
                No topics yet
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-6 max-w-md mx-auto">
                Start by generating study materials from URLs, PDFs, images, or YouTube videos.
                Each generation creates a topic with notes, flashcards, and quiz.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 6: Verify compile + build**

Run from project root:

```
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all three exit clean (no new errors vs. before the change).

- [ ] **Step 7: Smoke-test the dashboard**

Run `npm run dev`, open `http://localhost:3000/note` in the browser (Chrome MCP tool). Verify: content-type tabs switch, URL input + Generate behaves as before (or dry-run: Generate button disabled when input empty), topics grid renders, delete-topic hover button works.

- [ ] **Step 8: Commit**

```bash
git add lib/types.ts hooks/useGenerateContent.ts components/app/GenerateContentForm.tsx components/app/GenerateContentSheet.tsx app/note/page.tsx
git commit -m "refactor: extract generator into shared hook/form/sheet, dashboard rewired

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: TopicCard + ItemActionsMenu extension

**Files:**
- Modify: `components/app/ItemActionsMenu.tsx` (add optional `onDelete`, make `onMove` optional, add `buttonClassName`)
- Create: `components/app/notes/TopicCard.tsx`

**Interfaces:**
- Produces (used by Task 3): `TopicCard` props `{ topic: Topic; onDelete: (topicId: string) => void; onRename: (topic: Topic) => void; onMove: (topic: Topic) => void }`.
- `ItemActionsMenu` new optional props: `onDelete?: () => void; buttonClassName?: string`; `onMove` becomes optional (existing callers pass it, so they keep working).

- [ ] **Step 1: Extend `ItemActionsMenu.tsx`**

Replace the ENTIRE file with (changes: `onMove?`, `onDelete?`, `buttonClassName?`, Delete menu item, button className merge):

```tsx
"use client";

import { useState, useRef, useEffect } from "react";

interface ItemActionsMenuProps {
  onRename: () => void;
  onMove?: () => void;
  showMove?: boolean;
  onDelete?: () => void;
  buttonClassName?: string;
}

export function ItemActionsMenu({ onRename, onMove, showMove = true, onDelete, buttonClassName = "" }: ItemActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className={`p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors ${buttonClassName}`}
        title="More actions"
      >
        <span className="material-symbols-outlined text-lg">more_vert</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-white dark:bg-gray-900 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-20">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRename();
              setIsOpen(false);
            }}
            className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3"
          >
            <span className="material-symbols-outlined text-lg text-orange-600">edit</span>
            Rename
          </button>
          {showMove && onMove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onMove();
                setIsOpen(false);
              }}
              className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3"
            >
              <span className="material-symbols-outlined text-lg text-purple-600">drive_file_move</span>
              Move to Folder
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
                setIsOpen(false);
              }}
              className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 flex items-center gap-3"
            >
              <span className="material-symbols-outlined text-lg text-red-600">delete</span>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `components/app/notes/TopicCard.tsx`**

The notes-page topic card with the inline folder `<select>` footer REMOVED, a hover actions row (delete + ⋯ menu) added, and `overflow-hidden` moved onto the thumbnail so the ⋯ dropdown isn't clipped.

```tsx
"use client";

import Link from "next/link";
import { ItemActionsMenu } from "@/components/app/ItemActionsMenu";
import { Topic, getYouTubeThumbnail, getSourceIcon } from "@/lib/types";

interface TopicCardProps {
  topic: Topic;
  onDelete: (topicId: string) => void;
  onRename: (topic: Topic) => void;
  onMove: (topic: Topic) => void;
}

function formatDate(dateString: string) {
  const date = new Date(dateString);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - date.getTime());
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function TopicCard({ topic, onDelete, onRename, onMove }: TopicCardProps) {
  const thumbnail = topic.sourceType === "youtube" && topic.sourceUrl
    ? getYouTubeThumbnail(topic.sourceUrl)
    : null;

  return (
    <div className="group bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-sm hover:shadow-lg transition-all hover:border-blue-500 dark:hover:border-blue-500 relative">
      {/* Actions: revealed on hover, keyboard focus, and always on touch-sized screens */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-lg:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(topic.id);
          }}
          className="bg-red-500 hover:bg-red-600 text-white rounded-full p-2 shadow-lg"
          title="Delete topic"
        >
          <span className="material-symbols-outlined text-sm">delete</span>
        </button>
        <ItemActionsMenu
          onRename={() => onRename(topic)}
          onMove={() => onMove(topic)}
          buttonClassName="bg-white dark:bg-gray-900 shadow-sm"
        />
      </div>

      <Link href={`/note/topic/${topic.id}`} className="block">
        {thumbnail && (
          <div className="relative h-40 bg-gray-100 dark:bg-gray-800 rounded-t-xl overflow-hidden">
            <img src={thumbnail} alt="Thumbnail" className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-black/20 group-hover:bg-black/10 transition-colors" />
          </div>
        )}

        <div className="p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="bg-purple-100 dark:bg-purple-900/30 text-purple-600 rounded-md p-1.5">
              <span className="material-symbols-outlined">{getSourceIcon(topic.sourceType)}</span>
            </div>
            <span className="text-xs text-gray-500 dark:text-gray-400 uppercase">
              {topic.sourceType}
            </span>
          </div>

          <h3 className="text-base font-semibold text-gray-900 dark:text-white line-clamp-2 mb-3">
            {topic.title}
          </h3>

          {/* Material Indicators */}
          <div className="flex flex-wrap gap-2">
            {topic.note && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                <span className="material-symbols-outlined text-xs">description</span>
                Notes
              </span>
            )}
            {topic.flashcards && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                <span className="material-symbols-outlined text-xs">style</span>
                {topic.flashcards.length}
              </span>
            )}
            {topic.quiz && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300">
                <span className="material-symbols-outlined text-xs">quiz</span>
                {topic.quiz.length}
              </span>
            )}
          </div>
        </div>

        <div className="border-t border-gray-200 dark:border-gray-800 px-5 py-3 flex justify-between items-center">
          <span className="text-xs text-gray-600 dark:text-gray-400">{formatDate(topic.createdAt)}</span>
          <span className="text-sm font-medium text-blue-600 dark:text-blue-400 flex items-center gap-1">
            View <span className="material-symbols-outlined text-sm">arrow_forward</span>
          </span>
        </div>
      </Link>
    </div>
  );
}
```

- [ ] **Step 3: Verify compile**

```
npx tsc --noEmit
npm run lint
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add components/app/ItemActionsMenu.tsx components/app/notes/TopicCard.tsx
git commit -m "feat: TopicCard with actions menu; ItemActionsMenu gains optional delete

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Rewrite the My Notes page as the folder explorer

**Files:**
- Create: `components/app/notes/FolderTile.tsx`
- Modify: `app/note/notes/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: `GenerateContentSheet` (Task 1), `TopicCard` (Task 2), extended `ItemActionsMenu` (Task 2), existing `CreateFolderModal { isOpen, onClose, onCreateFolder(name, icon) }`, `RenameModal { isOpen, onClose, onRename(newName), currentTitle, itemType }`, `MoveFolderModal { isOpen, onClose, folders, currentFolderId, onMove(folderId: string | null) }`.
- Produces: URL contract `?folder=all|none|<folderId>`; unknown ids render the root view.

- [ ] **Step 1: Create `components/app/notes/FolderTile.tsx`**

```tsx
"use client";

import Link from "next/link";

interface FolderTileProps {
  href: string;
  name: string;
  count: number;
  icon?: string;          // emoji for user folders
  materialIcon?: string;  // Material Symbols name for the special tiles
}

export function FolderTile({ href, name, count, icon, materialIcon }: FolderTileProps) {
  return (
    <Link
      href={href}
      className="group flex flex-col items-center gap-3 p-5 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-sm hover:shadow-lg hover:border-purple-400 dark:hover:border-purple-400 transition-all"
    >
      <div className="w-14 h-14 rounded-2xl bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center group-hover:scale-105 transition-transform">
        {materialIcon ? (
          <span className="material-symbols-outlined text-3xl text-purple-600">{materialIcon}</span>
        ) : (
          <span className="text-3xl">{icon}</span>
        )}
      </div>
      <div className="text-center min-w-0 w-full">
        <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{name}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {count} note{count !== 1 ? "s" : ""}
        </p>
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: Rewrite `app/note/notes/page.tsx`**

Replace the ENTIRE file with:

```tsx
"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Sidebar } from "@/components/app/Sidebar";
import { useToast } from "@/components/app/ToastContainer";
import { getAllStudyGuides, categoryColors, difficultyColors, StudyGuide } from "@/lib/studyGuide";
import { persistProfileContent, loadProfileContent } from "@/lib/notesSync";
import { CreateFolderModal } from "@/components/app/CreateFolderModal";
import { RenameModal } from "@/components/app/RenameModal";
import { MoveFolderModal } from "@/components/app/MoveFolderModal";
import { ItemActionsMenu } from "@/components/app/ItemActionsMenu";
import { GenerateContentSheet } from "@/components/app/GenerateContentSheet";
import { FolderTile } from "@/components/app/notes/FolderTile";
import { TopicCard } from "@/components/app/notes/TopicCard";
import { Topic, ContentItem, Profile } from "@/lib/types";

interface Folder {
  id: string;
  name: string;
  icon: string;
  createdAt: string;
}

// Group stored content items into note-bearing topics (keeps folderId)
function buildTopics(content: ContentItem[]): Topic[] {
  const topicMap = new Map<string, Topic>();

  for (const item of content) {
    const sourceId = item.sourceId || `legacy_${item.id}`;

    if (!topicMap.has(sourceId)) {
      topicMap.set(sourceId, {
        id: sourceId,
        title: item.sourceName || item.title || "Unknown",
        sourceType: (item.sourceType as Topic["sourceType"]) || "url",
        sourceUrl: item.sourceType === "youtube" || item.sourceType === "url" ? item.sourceName : undefined,
        createdAt: item.createdAt,
        folderId: item.folderId,
      });
    }

    const topic = topicMap.get(sourceId)!;
    if (item.type === "notes" && item.data) {
      topic.note = item.data;
      if (item.data.title && item.data.title.length > 10) {
        topic.title = item.data.title;
      }
    } else if (item.type === "flashcards" && item.data?.flashcards) {
      topic.flashcards = item.data.flashcards;
    } else if (item.type === "quiz" && item.data?.quizzes) {
      topic.quiz = item.data.quizzes;
    }
  }

  return Array.from(topicMap.values())
    .filter((t) => t.note)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

// useSearchParams requires a Suspense boundary during prerendering in this
// Next.js version — see node_modules/next/dist/docs/ (use-search-params.md).
export default function NotesPage() {
  return (
    <Suspense fallback={null}>
      <NotesExplorer />
    </Suspense>
  );
}

function NotesExplorer() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [studyGuides, setStudyGuides] = useState<StudyGuide[]>([]);
  const [studyGuidesLoading, setStudyGuidesLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  // Toolbar + modal state
  const [generateSheetOpen, setGenerateSheetOpen] = useState(false);
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [renameFolderTarget, setRenameFolderTarget] = useState<Folder | null>(null);
  const [renameTopicTarget, setRenameTopicTarget] = useState<Topic | null>(null);
  const [moveTopicTarget, setMoveTopicTarget] = useState<Topic | null>(null);

  // Folder view resolution from the URL (?folder=all|none|<id>)
  const folderParam = searchParams.get("folder");
  const isSpecialView = folderParam === "all" || folderParam === "none";
  const activeFolder = !folderParam || isSpecialView
    ? null
    : folders.find((f) => f.id === folderParam) || null;
  const isRootView = !activeFolder && !isSpecialView;

  useEffect(() => {
    if (typeof window !== "undefined") {
      const currentProfile = localStorage.getItem("currentProfile");
      if (!currentProfile) {
        router.push("/note/profile-selection");
        return;
      }
      const profileData = JSON.parse(currentProfile);
      setProfile(profileData);
      setFolders(JSON.parse(localStorage.getItem(`folders_${profileData.id}`) || "[]"));

      // Load content and convert to topics
      const storedContent = localStorage.getItem(`content_${profileData.id}`);
      if (!storedContent) {
        // First visit on this device: pull content synced from other
        // devices / the iOS app, cache it, and reload once to display.
        loadProfileContent(profileData).then((cloud) => {
          if (cloud) window.location.reload();
        });
      }
      if (storedContent) {
        setTopics(buildTopics(JSON.parse(storedContent)));
      }
    }
  }, [router]);

  // Fetch public study guides
  useEffect(() => {
    async function fetchStudyGuides() {
      const data = await getAllStudyGuides();
      setStudyGuides(data);
      setStudyGuidesLoading(false);
    }
    fetchStudyGuides();
  }, []);

  // Folders (parity with the iOS app's folder organization)
  const persistFolders = (next: Folder[]) => {
    setFolders(next);
    if (profile && typeof window !== "undefined") {
      localStorage.setItem(`folders_${profile.id}`, JSON.stringify(next));
    }
  };

  const handleCreateFolder = (name: string, icon: string) => {
    persistFolders([...folders, { id: String(Date.now()), name, icon, createdAt: new Date().toISOString() }]);
    showToast(`Folder "${name}" created`, "success");
  };

  const handleRenameFolder = (newName: string) => {
    if (!renameFolderTarget) return;
    persistFolders(folders.map((f) => (f.id === renameFolderTarget.id ? { ...f, name: newName } : f)));
    setRenameFolderTarget(null);
  };

  const handleDeleteFolder = (folderId: string) => {
    if (!profile || typeof window === "undefined") return;
    if (!window.confirm("Delete this folder? Its topics move back to Unsorted.")) return;

    persistFolders(folders.filter((f) => f.id !== folderId));
    if (folderParam === folderId) router.replace("/note/notes");

    const storedContent = localStorage.getItem(`content_${profile.id}`);
    if (storedContent) {
      const content = JSON.parse(storedContent).map((item: ContentItem) =>
        item.folderId === folderId ? { ...item, folderId: undefined } : item
      );
      persistProfileContent(profile, content);
    }
    setTopics((prev) => prev.map((t) => (t.folderId === folderId ? { ...t, folderId: undefined } : t)));
  };

  const handleMoveTopic = (topicId: string, folderId: string | null) => {
    if (!profile || typeof window === "undefined") return;

    const storedContent = localStorage.getItem(`content_${profile.id}`);
    if (storedContent) {
      const content = JSON.parse(storedContent).map((item: ContentItem) =>
        item.sourceId === topicId || `legacy_${item.id}` === topicId
          ? { ...item, folderId: folderId ?? undefined }
          : item
      );
      persistProfileContent(profile, content);
    }
    setTopics((prev) =>
      prev.map((t) => (t.id === topicId ? { ...t, folderId: folderId ?? undefined } : t))
    );
  };

  const handleRenameTopic = (newName: string) => {
    if (!renameTopicTarget || !profile || typeof window === "undefined") return;

    const storedContent = localStorage.getItem(`content_${profile.id}`);
    if (storedContent) {
      const content = JSON.parse(storedContent).map((item: ContentItem) =>
        item.sourceId === renameTopicTarget.id || `legacy_${item.id}` === renameTopicTarget.id
          ? { ...item, title: newName }
          : item
      );
      persistProfileContent(profile, content);
    }
    setTopics((prev) =>
      prev.map((t) => (t.id === renameTopicTarget.id ? { ...t, title: newName } : t))
    );
    setRenameTopicTarget(null);
    showToast("Topic renamed", "success");
  };

  const handleDeleteTopic = (topicId: string) => {
    if (!profile || typeof window === "undefined") return;
    if (!window.confirm("Delete this topic?")) return;

    const storedContent = localStorage.getItem(`content_${profile.id}`);
    if (storedContent) {
      const content = JSON.parse(storedContent);
      const updatedContent = content.filter((item: ContentItem) => item.sourceId !== topicId);
      persistProfileContent(profile, updatedContent);

      setTopics(topics.filter((t) => t.id !== topicId));
    }
    showToast("Topic deleted", "success");
  };

  const categories = Array.from(new Set(studyGuides.map((g) => g.category)));
  const filteredGuides = selectedCategory
    ? studyGuides.filter((g) => g.category === selectedCategory)
    : studyGuides;

  const unsortedCount = topics.filter((t) => !t.folderId).length;
  const countForFolder = (id: string) => topics.filter((t) => String(t.folderId) === id).length;

  const visibleTopics = activeFolder
    ? topics.filter((t) => String(t.folderId) === activeFolder.id)
    : folderParam === "none"
      ? topics.filter((t) => !t.folderId)
      : topics;

  if (!profile) return null;

  const viewTitle = activeFolder
    ? `${activeFolder.icon} ${activeFolder.name}`
    : folderParam === "none"
      ? "Unsorted"
      : "All Notes";

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-950 overflow-hidden">
      <Sidebar profile={profile} />
      <main className="flex-1 overflow-y-auto">
        <div className="px-4 sm:px-6 lg:px-10 py-8 w-full max-w-6xl mx-auto">
          {isRootView ? (
            <>
              {/* Header + toolbar */}
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
                <div>
                  <h1 className="text-3xl font-bold text-gray-900 dark:text-white">My Notes</h1>
                  <p className="text-gray-600 dark:text-gray-400 mt-2">
                    {topics.length} topic{topics.length !== 1 ? "s" : ""} · {folders.length} folder{folders.length !== 1 ? "s" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setGenerateSheetOpen(true)}
                    className="btn-primary inline-flex items-center gap-2"
                  >
                    <span className="material-symbols-outlined">add</span>
                    Generate Content
                  </button>
                  <button
                    onClick={() => setCreateFolderOpen(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm font-medium"
                  >
                    <span className="material-symbols-outlined text-base">create_new_folder</span>
                    New Folder
                  </button>
                </div>
              </div>

              {/* Folder tile grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-4">
                <FolderTile href="/note/notes?folder=all" materialIcon="library_books" name="All Notes" count={topics.length} />
                <FolderTile href="/note/notes?folder=none" materialIcon="inbox" name="Unsorted" count={unsortedCount} />
                {folders.map((f) => (
                  <FolderTile
                    key={f.id}
                    href={`/note/notes?folder=${f.id}`}
                    icon={f.icon}
                    name={f.name}
                    count={countForFolder(f.id)}
                  />
                ))}
              </div>
              {folders.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-12">
                  Create a folder to organize your notes.
                </p>
              )}
              {topics.length === 0 && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-12">
                  Generate study materials to create your first topic.
                </p>
              )}
            </>
          ) : (
            <>
              {/* Folder view */}
              <div className="mb-8">
                <Link
                  href="/note/notes"
                  className="inline-flex items-center gap-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-4"
                >
                  <span className="material-symbols-outlined text-base">arrow_back</span>
                  My Notes
                </Link>
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{viewTitle}</h1>
                    <p className="text-gray-600 dark:text-gray-400 mt-2">
                      {visibleTopics.length} topic{visibleTopics.length !== 1 ? "s" : ""} with notes
                    </p>
                  </div>
                  {activeFolder && (
                    <ItemActionsMenu
                      onRename={() => setRenameFolderTarget(activeFolder)}
                      showMove={false}
                      onDelete={() => handleDeleteFolder(activeFolder.id)}
                      buttonClassName="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm"
                    />
                  )}
                </div>
              </div>

              {visibleTopics.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
                  {visibleTopics.map((topic) => (
                    <TopicCard
                      key={topic.id}
                      topic={topic}
                      onDelete={handleDeleteTopic}
                      onRename={(t) => setRenameTopicTarget(t)}
                      onMove={(t) => setMoveTopicTarget(t)}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 mb-12">
                  <span className="material-symbols-outlined text-6xl text-gray-300 dark:text-gray-600 mb-4">description</span>
                  <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
                    No notes {activeFolder ? `in ${activeFolder.name}` : "yet"}
                  </h2>
                  <p className="text-gray-600 dark:text-gray-400 mb-6">
                    {activeFolder
                      ? `Generate study materials straight into ${activeFolder.name}`
                      : "Generate study materials to create your first topic"}
                  </p>
                  <button onClick={() => setGenerateSheetOpen(true)} className="btn-primary inline-flex items-center gap-2">
                    <span className="material-symbols-outlined">add</span>
                    Generate Content
                  </button>
                </div>
              )}
            </>
          )}

          {/* Modals */}
          <CreateFolderModal
            isOpen={createFolderOpen}
            onClose={() => setCreateFolderOpen(false)}
            onCreateFolder={handleCreateFolder}
          />
          <RenameModal
            isOpen={!!renameFolderTarget}
            onClose={() => setRenameFolderTarget(null)}
            onRename={handleRenameFolder}
            currentTitle={renameFolderTarget?.name || ""}
            itemType="folder"
          />
          <RenameModal
            isOpen={!!renameTopicTarget}
            onClose={() => setRenameTopicTarget(null)}
            onRename={handleRenameTopic}
            currentTitle={renameTopicTarget?.title || ""}
            itemType="topic"
          />
          <MoveFolderModal
            isOpen={!!moveTopicTarget}
            onClose={() => setMoveTopicTarget(null)}
            folders={folders}
            currentFolderId={moveTopicTarget?.folderId ? String(moveTopicTarget.folderId) : null}
            onMove={(folderId) => moveTopicTarget && handleMoveTopic(moveTopicTarget.id, folderId)}
          />
          <GenerateContentSheet
            isOpen={generateSheetOpen}
            onClose={() => setGenerateSheetOpen(false)}
            profile={profile}
            targetFolderId={activeFolder?.id}
            targetFolderName={activeFolder?.name}
            onGenerated={(updatedContent) => {
              setTopics(buildTopics(updatedContent));
              setGenerateSheetOpen(false);
            }}
          />

          {/* Public Study Guides Section (root only) */}
          {isRootView && (
            <div className="border-t border-gray-200 dark:border-gray-800 pt-12">
              <div className="mb-8">
                <div className="flex items-center gap-3 mb-2">
                  <div className="bg-purple-100 dark:bg-purple-900/30 text-purple-600 rounded-lg p-2">
                    <span className="material-symbols-outlined">public</span>
                  </div>
                  <div>
                    <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Public Study Guides</h2>
                    <p className="text-gray-600 dark:text-gray-400 text-sm">
                      Curated study materials with video summaries and interactive quizzes
                    </p>
                  </div>
                </div>
              </div>

              {/* Category Filter */}
              {categories.length > 0 && (
                <div className="flex flex-wrap gap-3 mb-6">
                  <button
                    onClick={() => setSelectedCategory(null)}
                    className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                      selectedCategory === null
                        ? "bg-[#964CEE] text-white"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                    }`}
                  >
                    All
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setSelectedCategory(cat)}
                      className={`px-4 py-2 rounded-full text-sm font-medium capitalize transition-all ${
                        selectedCategory === cat
                          ? "bg-[#964CEE] text-white"
                          : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              )}

              {/* Loading State */}
              {studyGuidesLoading && (
                <div className="text-center py-12">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#964CEE]"></div>
                  <p className="text-gray-500 dark:text-gray-400 mt-4">Loading study guides...</p>
                </div>
              )}

              {/* Study Guides Grid */}
              {!studyGuidesLoading && filteredGuides.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredGuides.map((guide) => (
                    <Link
                      key={guide.slug}
                      href={`/note/${guide.slug}`}
                      className="group bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl overflow-hidden hover:border-[#964CEE]/50 transition-all duration-300"
                    >
                      {/* Thumbnail */}
                      <div className="relative aspect-video bg-gray-100 dark:bg-gray-800 overflow-hidden">
                        {guide.youtubeId ? (
                          <img
                            src={`https://img.youtube.com/vi/${guide.youtubeId}/maxresdefault.jpg`}
                            alt={guide.title}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                            onError={(e) => {
                              const target = e.target as HTMLImageElement;
                              if (target.src.includes("maxresdefault")) {
                                target.src = `https://img.youtube.com/vi/${guide.youtubeId}/hqdefault.jpg`;
                              } else if (target.src.includes("hqdefault")) {
                                target.src = `https://img.youtube.com/vi/${guide.youtubeId}/mqdefault.jpg`;
                              }
                            }}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#964CEE]/20 to-[#964CEE]/5">
                            <span className="material-symbols-outlined text-4xl text-[#964CEE]">menu_book</span>
                          </div>
                        )}
                        {/* Play overlay */}
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="w-12 h-12 rounded-full bg-[#964CEE] flex items-center justify-center">
                            <svg className="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M8 5v14l11-7z" />
                            </svg>
                          </div>
                        </div>
                        {/* Category badge */}
                        <div
                          className={`absolute top-3 left-3 px-3 py-1 rounded-full text-xs font-semibold bg-gradient-to-r ${
                            categoryColors[guide.category] || "from-gray-500 to-gray-500"
                          } text-white`}
                        >
                          {guide.category}
                        </div>
                      </div>

                      {/* Content */}
                      <div className="p-4">
                        <h3 className="text-base font-semibold text-gray-900 dark:text-white mb-2 group-hover:text-[#964CEE] transition-colors line-clamp-2">
                          {guide.title}
                        </h3>

                        {/* Meta */}
                        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 mb-2">
                          <span className="flex items-center gap-1">
                            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                            </svg>
                            {guide.quiz.length} Quiz
                          </span>
                          <span
                            className={`px-2 py-0.5 rounded border ${
                              difficultyColors[guide.difficulty] || "bg-gray-500/20 text-gray-400"
                            }`}
                          >
                            {guide.difficulty}
                          </span>
                        </div>

                        {/* TL;DR Preview */}
                        {guide.tldr && guide.tldr[0] && (
                          <p className="text-sm text-gray-500 dark:text-gray-400 line-clamp-2">{guide.tldr[0]}</p>
                        )}

                        {/* Source */}
                        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between">
                          <span className="text-xs text-gray-400 dark:text-gray-500">by {guide.sourceChannel}</span>
                          <span className="text-xs text-[#964CEE] group-hover:underline">View →</span>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}

              {/* Empty State */}
              {!studyGuidesLoading && studyGuides.length === 0 && (
                <div className="text-center py-12 bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800">
                  <div className="text-5xl mb-4">📚</div>
                  <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">No Study Guides Yet</h3>
                  <p className="text-gray-500 dark:text-gray-400">Check back soon for new content!</p>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Verify compile + build**

```
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all three clean.

- [ ] **Step 4: Commit**

```bash
git add components/app/notes/FolderTile.tsx app/note/notes/page.tsx
git commit -m "feat: My Notes becomes iOS-style folder explorer with generate sheet

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Full manual verification pass

**Files:**
- Fix-only: any file from Tasks 1–3 if the checklist below finds a defect.

- [ ] **Step 1: Start the dev server**

Run `npm run dev` (background). Wait for "Ready". Open `http://localhost:3000/note` — if redirected to profile-selection, create/pick a profile first.

- [ ] **Step 2: Explorer checklist (use the Chrome browser tool)**

Verify each item, fixing defects as found:

1. `/note/notes` shows the toolbar: **Generate Content** + **New Folder** side by side, tile grid with All Notes / Unsorted (+ any existing folders), Public Study Guides below.
2. **New Folder** → modal → create "Biology" 📘 → tile appears with count 0.
3. Open Biology → URL shows `?folder=<id>`, back link visible, empty state offers Generate Content.
4. Generate from inside Biology (paste a URL) → sheet shows "Saving to: Biology" → after success the sheet closes and the topic appears in Biology with the tile count at 1.
5. Generate from root → note lands in Unsorted (root sheet, no target).
6. Topic card hover → ⋯ menu → **Move to Folder** → move the root-generated note into Biology → it disappears from Unsorted, Biology count updates.
7. ⋯ menu → **Rename** on a topic → RenameModal → title updates.
8. Folder header ⋯ → **Rename** works; **Delete** confirms, unsorts its topics, and if you were inside the deleted folder you land back on root.
9. Browser Back from a folder view returns to root; Forward re-enters. Refresh inside a folder keeps you there.
10. Visit `/note/notes?folder=999999` (nonexistent) → root renders.
11. Dashboard `/note` still generates and lists topics exactly as before.
12. Toggle dark mode (sidebar/settings as existing) → explorer renders correctly dark.
13. Narrow viewport to ~375px → tiles wrap 2-per-row, toolbar stacks, no horizontal scroll, and the topic-card action row (delete + ⋯) is visible without hovering; deleting a topic asks for confirmation.

- [ ] **Step 3: Final build + commit any fixes**

```
npx tsc --noEmit
npm run lint
npm run build
```

If fixes were made, commit them:

```bash
git add -A
git commit -m "fix: polish from folder explorer manual pass

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

(If no fixes were needed, skip the commit.)
