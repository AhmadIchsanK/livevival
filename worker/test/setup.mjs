// scheduleSync.mjs / finishedMatchSync.mjs import config.mjs, which builds a
// Supabase client at module-load time and throws if these are unset. The
// functions under test never actually call Supabase, but the import graph
// still requires the client to construct successfully.
process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
