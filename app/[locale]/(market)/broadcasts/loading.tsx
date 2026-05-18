export default function Loading() {
  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="h-8 w-48 bg-gray-200 rounded animate-pulse mb-2" />
      <div className="h-4 w-64 bg-gray-100 rounded animate-pulse mb-6" />
      <div className="grid md:grid-cols-2 gap-6">
        <div>
          <div className="h-8 w-32 bg-gray-100 rounded animate-pulse mb-3" />
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 42 }).map((_, i) => (
              <div key={i} className="aspect-square bg-gray-100 rounded-lg animate-pulse" />
            ))}
          </div>
        </div>
        <div>
          <div className="h-6 w-40 bg-gray-100 rounded animate-pulse mb-4" />
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 bg-gray-100 rounded-lg animate-pulse mb-2" />
          ))}
        </div>
      </div>
    </div>
  );
}
