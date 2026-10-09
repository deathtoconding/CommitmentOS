import { AppSectionPage, type AppSearchParams } from '@/app-shell/section-page';

type AppHomePageProps = {
  searchParams: Promise<AppSearchParams>;
};

export default function AppHomePage({ searchParams }: AppHomePageProps) {
  return <AppSectionPage section="dashboard" searchParams={searchParams} />;
}
