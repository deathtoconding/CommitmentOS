import { AppSectionPage, type AppSearchParams } from '@/app-shell/section-page';

type CommitmentsPageProps = {
  searchParams: Promise<AppSearchParams>;
};

export default function CommitmentsPage({ searchParams }: CommitmentsPageProps) {
  return <AppSectionPage section="commitments" searchParams={searchParams} />;
}
