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
  const keyRaw = sp.key;
  const demoKey = Array.isArray(keyRaw) ? keyRaw[0] : keyRaw;

  return <DemoClient companySlug={company} demoKey={demoKey ?? ""} />;
}

