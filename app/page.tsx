import { PostPublisher } from "@/components/post-publisher";

export default function ComposePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-4 py-12">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Redactar publicación</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Escribe una vez y publícalo en varias redes. El estado se muestra por red
          según la respuesta de la API.
        </p>
      </header>
      <PostPublisher />
    </main>
  );
}
