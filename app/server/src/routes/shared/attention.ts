// "Need your Attention" — one aggregated, role-appropriate list of pending-approval items for
// the CURRENTLY LOGGED-IN user, backing the real-time dashboard widget every role now gets
// (Employee Dashboard already had its own separate "Pending Action(s)" panel — this is the
// cross-cutting counterpart for approval flows: CTC, Appraisal, Termination/FnF, Timesheet, IT
// provisioning/offboarding). The socket side (engine/realtime.ts's emitAttention, joined via
// `attention:role:<role>`) only ever pushes a lightweight "go refetch" ping — this route is the
// actual source of truth the widget re-queries on receipt.
import { Router } from "express";
import { prisma } from "../../prisma";
import { ADMIN_ROLES } from "../../auth/auth";
import { Role } from "@prisma/client";

const router = Router();
const isAdmin = (role: Role) => ADMIN_ROLES.includes(role);
// CTC/Appraisal/Termination/Finance-timesheet approvals are all FINANCE/CTO/CEO/COO-reviewed —
// same APPROVER_ROLES set each of those routes already gates on.
const APPROVAL_ROLES: Role[] = [Role.FINANCE, Role.CTO, Role.CEO, Role.COO];

router.get("/dashboard/attention", async (req, res) => {
  const u = req.user!;
  const items: { label: string; count: number; href: string }[] = [];

  if (APPROVAL_ROLES.includes(u.role) || isAdmin(u.role)) {
    const [ctcCount, appraisalCount, terminationCount, financeTsCount] = await Promise.all([
      prisma.ctcApprovalRequest.count({ where: { status: "PENDING" } }),
      prisma.appraisal.count({ where: { status: "ISSUED" } }),
      prisma.terminationApprovalRequest.count({ where: { status: "PENDING" } }),
      prisma.timesheet.count({ where: { status: "PM_APPROVED" } }),
    ]);
    if (ctcCount) items.push({ label: `${ctcCount} CTC approval${ctcCount === 1 ? "" : "s"} pending`, count: ctcCount, href: "/ctc-approvals" });
    if (appraisalCount) items.push({ label: `${appraisalCount} appraisal approval${appraisalCount === 1 ? "" : "s"} pending`, count: appraisalCount, href: "/appraisal-approvals" });
    if (terminationCount) items.push({ label: `${terminationCount} termination/FnF approval${terminationCount === 1 ? "" : "s"} pending`, count: terminationCount, href: "/termination-approvals" });
    if (financeTsCount) items.push({ label: `${financeTsCount} timesheet${financeTsCount === 1 ? "" : "s"} awaiting Finance approval`, count: financeTsCount, href: "/approved-hours" });
  }

  // Additional Profile Details — reviewed by the same roles ess.ts's DOC_APPROVE_ROLES (==
  // HR_SETTINGS_ROLES) gates on: HR, plus CEO/COO/CTO/FINANCE (already covered by APPROVAL_ROLES
  // above, so only plain HR needs its own branch here). Previously missing entirely — an
  // employee's "Pending HR Approval" submission never surfaced anywhere on the HR Dashboard.
  if (u.role === Role.HR || APPROVAL_ROLES.includes(u.role) || isAdmin(u.role)) {
    const profileSubmissionCount = await prisma.employeeProfileSubmission.count({ where: { status: "PENDING" } });
    if (profileSubmissionCount) items.push({ label: `${profileSubmissionCount} Additional Profile Details submission${profileSubmissionCount === 1 ? "" : "s"} pending review`, count: profileSubmissionCount, href: "/hr/profile-submissions" });
  }

  if (u.role === Role.PROJECT_MANAGER && u.employeeId) {
    const assigned = await prisma.projectManager.findMany({ where: { employeeId: u.employeeId }, select: { projectId: true } });
    const projectIds = assigned.map((a) => a.projectId);
    const tsCount = projectIds.length ? await prisma.timesheet.count({ where: { status: "SUBMITTED", projectId: { in: projectIds } } }) : 0;
    if (tsCount) items.push({ label: `${tsCount} timesheet${tsCount === 1 ? "" : "s"} awaiting your approval`, count: tsCount, href: "/approvals" });
  }

  if (u.role === Role.IT_ADMIN) {
    const [provisioningCount, offboardingCount] = await Promise.all([
      prisma.itProvisioningRequest.count({ where: { sentAt: { not: null }, emailCreatedAt: null } }),
      prisma.itOffboardingRequest.count({ where: { completedAt: null } }),
    ]);
    if (provisioningCount) items.push({ label: `${provisioningCount} IT provisioning request${provisioningCount === 1 ? "" : "s"} pending`, count: provisioningCount, href: "/it-admin" });
    if (offboardingCount) items.push({ label: `${offboardingCount} offboarding task${offboardingCount === 1 ? "" : "s"} pending`, count: offboardingCount, href: "/it-admin/offboarding" });
  }

  res.json({ items });
});

export default router;
