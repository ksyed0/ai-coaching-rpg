// The screen's title and what to do on it: the page's one h1.

export function TitleBlock({ title, lede }: { title: string; lede: string }) {
  return (
    <div className="tb">
      <h1>{title}</h1>
      <p>{lede}</p>
    </div>
  );
}
