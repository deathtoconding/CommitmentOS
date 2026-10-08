import { AppSectionPage, type AppSearchParams } from '@/app-shell/section-page';

type IntegrationsPageProps = {
  searchParams: Promise<AppSearchParams>;
};

export default function IntegrationsPage({ searchParams }: IntegrationsPageProps) {
  return <AppSectionPage section="integrations" searchParams={searchParams} />;
}
