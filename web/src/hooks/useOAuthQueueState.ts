import { useEffect, useRef, useState } from "react";
import { createOAuthJobStore, type OAuthJobStore } from "../lib/oauth-job-store";
import type { OAuthJob } from "../types";

export function useOAuthQueueState() {
  const [oauthQueueJobs, setOAuthQueueJobs] = useState<OAuthJob[]>([]);
  const oauthJobStoreRef = useRef<OAuthJobStore | null>(null);

  if (oauthJobStoreRef.current === null) {
    oauthJobStoreRef.current = createOAuthJobStore();
  }
  const oauthJobStore = oauthJobStoreRef.current;

  useEffect(() => {
    setOAuthQueueJobs(oauthJobStore.load());
  }, [oauthJobStore]);

  function replaceOAuthQueueJobs(jobs: OAuthJob[]) {
    setOAuthQueueJobs(jobs);
  }

  function persistOAuthQueueJobs(jobs: OAuthJob[]) {
    oauthJobStore.save(jobs);
    setOAuthQueueJobs(jobs);
  }

  function clearOAuthQueueJobs() {
    oauthJobStore.clear();
    setOAuthQueueJobs([]);
  }

  return {
    oauthJobStore,
    oauthQueueJobs,
    replaceOAuthQueueJobs,
    persistOAuthQueueJobs,
    clearOAuthQueueJobs,
  };
}
