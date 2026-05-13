export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-background text-foreground p-6">
      <div className="text-center space-y-3">
        <h1 className="text-2xl font-semibold">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          The page you are looking for does not exist.
        </p>
        <a href="/mission-control" className="btn btn-primary mt-4">
          Go to mission control
        </a>
      </div>
    </div>
  );
}
