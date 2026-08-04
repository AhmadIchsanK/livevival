export default function ContributorHomePage() {
  return (
    <div className="text-white space-y-2">
      <h1 className="text-xl font-semibold">Contributor Dashboard</h1>
      <p className="text-sm text-white/60">
        Pick an entity from the nav above to submit an edit request, or check{" "}
        <a href="/contributor/requests" className="text-signal hover:underline">
          My Requests
        </a>{" "}
        for the status of your past submissions.
      </p>
    </div>
  );
}
