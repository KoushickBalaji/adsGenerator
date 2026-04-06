import DemoClient from "./demo-client";

type SearchParams = { [key: string]: string | string[] | undefined };

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ company: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { company } = await params;
  const sp = await searchParams;
  const urlRaw = sp.url;
  const initialUrl = Array.isArray(urlRaw) ? urlRaw[0] : urlRaw;
  const autostartRaw = sp.autostart;
  const autostart = (Array.isArray(autostartRaw) ? autostartRaw[0] : autostartRaw) === "1";

  return <DemoClient companySlug={company} initialUrl={initialUrl ?? ""} autostart={autostart} />;
}
