import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth.jsx';
import { LoadingPage, Empty } from './components/ui.jsx';
import { OfficerShell, AdminShell } from './components/Shells.jsx';

import LoginPage from './pages/LoginPage.jsx';
import ChangePinPage from './pages/ChangePinPage.jsx';

import HomePage from './pages/officer/HomePage.jsx';
import SchedulePage from './pages/officer/SchedulePage.jsx';
import IncidentsPage from './pages/officer/IncidentsPage.jsx';
import NewIncidentPage from './pages/officer/NewIncidentPage.jsx';
import ToursPage from './pages/officer/ToursPage.jsx';
import TourRunPage from './pages/officer/TourRunPage.jsx';
import UpdatesPage from './pages/officer/UpdatesPage.jsx';
import ProfilePage from './pages/officer/ProfilePage.jsx';
import PostLogPage from './pages/officer/PostLogPage.jsx';

import DashboardPage from './pages/admin/DashboardPage.jsx';
import EmployeesPage from './pages/admin/EmployeesPage.jsx';
import EmployeeDetailPage from './pages/admin/EmployeeDetailPage.jsx';
import AdminSchedulePage from './pages/admin/SchedulePage.jsx';
import TimesheetsPage from './pages/admin/TimesheetsPage.jsx';
import FlagsPage from './pages/admin/FlagsPage.jsx';
import AdminIncidentsPage from './pages/admin/IncidentsPage.jsx';
import SitesPage from './pages/admin/SitesPage.jsx';
import AdminToursPage from './pages/admin/ToursPage.jsx';
import BroadcastsPage from './pages/admin/BroadcastsPage.jsx';
import AdminTrainingPage from './pages/admin/TrainingPage.jsx';
import AuditPage from './pages/admin/AuditPage.jsx';
import SafetyPage from './pages/admin/SafetyPage.jsx';
import TimeOffPage from './pages/admin/TimeOffPage.jsx';
import CompliancePage from './pages/admin/CompliancePage.jsx';
import DarPage from './pages/admin/DarPage.jsx';
import ShiftRequestsPage from './pages/admin/ShiftRequestsPage.jsx';
import ClientsPage from './pages/admin/ClientsPage.jsx';
import InvoicesPage from './pages/admin/InvoicesPage.jsx';
import EmailsPage from './pages/admin/EmailsPage.jsx';
import LivePage from './pages/admin/LivePage.jsx';
import PunchesPage from './pages/admin/PunchesPage.jsx';
import EquipmentPage from './pages/admin/EquipmentPage.jsx';
import PayRatesPage from './pages/admin/PayRatesPage.jsx';
import PayrollPage from './pages/admin/PayrollPage.jsx';
import CoverageRequestsPage from './pages/admin/CoverageRequestsPage.jsx';
import PayrollPeriodPage from './pages/admin/PayrollPeriodPage.jsx';
import ReportsPage from './pages/admin/ReportsPage.jsx';
import PostLogsPage from './pages/admin/PostLogsPage.jsx';

/** Supervisors and admins only; officers get a plain explanation, not a crash. */
function RequireSupervisor({ children }) {
  const { isSupervisor } = useAuth();
  if (!isSupervisor) {
    return (
      <div className="page">
        <Empty icon="shield" title="Admin access only">
          This area is limited to field supervisors and administrators.
        </Empty>
      </div>
    );
  }
  return children;
}

export default function App() {
  const { user, loading, mustChangePin } = useAuth();

  if (loading) return <LoadingPage label="Starting USA Security Connect" />;
  if (!user) return <LoginPage />;

  // A supervisor-issued PIN has to be replaced before anything else happens.
  if (mustChangePin) return <ChangePinPage forced />;

  return (
    <Routes>
      <Route element={<OfficerShell />}>
        <Route index element={<HomePage />} />
        <Route path="schedule" element={<SchedulePage />} />
        <Route path="incidents" element={<IncidentsPage />} />
        <Route path="incidents/new" element={<NewIncidentPage />} />
        <Route path="tours" element={<ToursPage />} />
        <Route path="tours/:runId" element={<TourRunPage />} />
        <Route path="messages" element={<UpdatesPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="post-log" element={<PostLogPage />} />
      </Route>

      <Route path="change-pin" element={<ChangePinPage />} />

      <Route
        path="admin"
        element={
          <RequireSupervisor>
            <AdminShell />
          </RequireSupervisor>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="live" element={<LivePage />} />
        <Route path="punches" element={<PunchesPage />} />
        <Route path="equipment" element={<EquipmentPage />} />
        <Route path="pay-rates" element={<PayRatesPage />} />
        <Route path="payroll" element={<PayrollPage />} />
        <Route path="coverage-requests" element={<CoverageRequestsPage />} />
        <Route path="payroll/:id" element={<PayrollPeriodPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="post-logs" element={<PostLogsPage />} />
        <Route path="employees" element={<EmployeesPage />} />
        <Route path="employees/:id" element={<EmployeeDetailPage />} />
        <Route path="schedule" element={<AdminSchedulePage />} />
        <Route path="timesheets" element={<TimesheetsPage />} />
        <Route path="time-off" element={<TimeOffPage />} />
        <Route path="shift-requests" element={<ShiftRequestsPage />} />
        <Route path="compliance" element={<CompliancePage />} />
        <Route path="safety" element={<SafetyPage />} />
        <Route path="dar" element={<DarPage />} />
        <Route path="flags" element={<FlagsPage />} />
        <Route path="incidents" element={<AdminIncidentsPage />} />
        <Route path="sites" element={<SitesPage />} />
        <Route path="clients" element={<ClientsPage />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="emails" element={<EmailsPage />} />
        <Route path="tours" element={<AdminToursPage />} />
        <Route path="broadcasts" element={<BroadcastsPage />} />
        <Route path="training" element={<AdminTrainingPage />} />
        <Route path="audit" element={<AuditPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
