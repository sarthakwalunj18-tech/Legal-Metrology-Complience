"use client";

import React, { useEffect, useState, use } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardHeader, CardBody, CardFooter } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge, StatusType } from "@/components/ui/Badge";
import {
  History,
  Calendar,
  Eye,
  ArrowLeft,
} from "lucide-react";
import { ApiRequestError, apiFetch } from "@/lib/session";
import type { Product } from "@/lib/domain";

export default function ProductHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [productData, setProductData] = useState<ProductDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ProductDetailResponse>(
      `/products/${encodeURIComponent(id)}/history`,
    )
      .then((data) => {
        setProductData(data);
        setError(null);
      })
      .catch((cause: unknown) => {
        setProductData(null);
        setError(
          cause instanceof ApiRequestError ? cause.message : "Unable to reach the enforcement API.",
        );
      })
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex min-h-screen bg-[#F8FAFC]">
        <Sidebar />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-xs text-slate-500 font-medium">Loading product history...</p>
          </div>
        </div>
      </div>
    );
  }

  const product = productData?.product;

  if (!product) {
    return (
      <div className="flex min-h-screen bg-[#F8FAFC]">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar breadcrumbs={[{ label: "Products Registry", href: "/products" }, { label: "Not found" }]} />
          <main className="p-8 max-w-6xl w-full mx-auto flex-1">
            <div className="p-6 bg-white border border-slate-200 rounded-xl text-center space-y-3">
              <p className="text-sm font-semibold text-slate-800">This product record is unavailable.</p>
              <p className="text-xs text-slate-500">{error ?? "The commodity does not exist in the catalogue."}</p>
              <Link href="/products">
                <Button variant="secondary" size="sm" icon={<ArrowLeft className="w-4 h-4" />}>
                  Back to catalogue
                </Button>
              </Link>
            </div>
          </main>
        </div>
      </div>
    );
  }

  const inspectionHistory: ProductHistoryScan[] = productData?.history ?? [];

  return (
    <div className="flex min-h-screen bg-[#F8FAFC]">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          breadcrumbs={[
            { label: "Products Registry", href: "/products" },
            { label: product.name },
          ]}
        />

        <main className="p-8 max-w-6xl w-full mx-auto space-y-6 flex-1">
          <div className="flex items-center justify-between pb-2 border-b border-slate-200">
            <div className="flex items-center gap-3">
              <Link href="/products">
                <Button variant="secondary" size="sm" icon={<ArrowLeft className="w-4 h-4" />}>
                  Back
                </Button>
              </Link>
              <div>
                <h1 className="text-2xl font-bold text-[#12304A] tracking-tight">
                  {product.name}
                </h1>
                <p className="text-xs text-slate-500 mt-0.5">
                  Longitudinal Regulatory History • {inspectionHistory.length} Inspection Audits Logged
                </p>
              </div>
            </div>
          </div>

          {/* Product Profile Card */}
          <Card>
            <CardBody className="p-6 grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
              <div>
                <span className="text-slate-400 font-semibold uppercase text-[10px]">Brand / Trademark</span>
                <div className="text-slate-800 font-semibold text-sm mt-0.5">{product.brand || "N/A"}</div>
              </div>
              <div>
                <span className="text-slate-400 font-semibold uppercase text-[10px]">Statutory Category</span>
                <div className="text-slate-800 font-semibold text-sm mt-0.5">{product.category}</div>
              </div>
              <div>
                <span className="text-slate-400 font-semibold uppercase text-[10px]">Commodity Nature</span>
                <div className="text-slate-800 font-semibold text-sm mt-0.5">{product.commodityType || "Solid/Liquid"}</div>
              </div>
              <div>
                <span className="text-slate-400 font-semibold uppercase text-[10px]">Manufacturer</span>
                <div className="text-slate-800 font-medium text-xs mt-0.5">{product.manufacturerName || "Declared on Label"}</div>
              </div>
            </CardBody>
          </Card>

          {/* Longitudinal Timeline */}
          <div className="space-y-4">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <History className="w-4 h-4 text-[#12304A]" /> Longitudinal Inspection Trail (Module 16)
            </h2>

            <div className="relative border-l-2 border-slate-200 ml-4 pl-6 space-y-6">
              {inspectionHistory.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No inspections have been recorded against this commodity yet.
                </p>
              ) : (
                inspectionHistory.map((scan, idx) => (
                <div key={scan.id || idx} className="relative">
                  {/* Timeline Dot */}
                  <div
                    className={`absolute -left-[31px] top-1.5 w-4 h-4 rounded-full border-2 border-white shadow-xs ${
                      scan.complianceStatus === "COMPLIANT"
                        ? "bg-emerald-500"
                        : scan.complianceStatus === "NON_COMPLIANT"
                        ? "bg-red-500"
                        : "bg-amber-500"
                    }`}
                  />

                  <Card className="hover:shadow-md transition-shadow">
                    <CardHeader
                      title={
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-xs font-semibold px-2 py-0.5 bg-slate-100 rounded text-slate-800">
                            {scan.scanNumber}
                          </span>
                          <StatusBadge status={scan.complianceStatus as StatusType} size="sm" />
                        </div>
                      }
                      action={
                        <span className="text-xs text-slate-500 flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5" />
                          {new Date(scan.createdAt).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </span>
                      }
                    />
                    <CardBody className="space-y-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500">
                          Compliance Score:{" "}
                          <strong>
                            {scan.complianceScore != null ? `${Math.round(Number(scan.complianceScore))}%` : "Not scored"}
                          </strong>
                        </span>
                        <span className="text-slate-500">
                          Officer Decision:{" "}
                          <strong className="text-slate-800">{scan.reviewStatus ?? "NOT REVIEWED"}</strong>
                        </span>
                      </div>
                      {'' && (
                        <div className="p-2.5 bg-slate-50 border border-slate-100 rounded text-slate-600 text-[11px]">
                          <strong>Inspector Observation:</strong> {''}
                        </div>
                      )}
                    </CardBody>
                    <CardFooter>
                      <Link href={`/inspections/${scan.id}`} className="ml-auto">
                        <Button variant="secondary" size="sm" icon={<Eye className="w-3.5 h-3.5" />}>
                          View Full Evidence & Checks
                        </Button>
                      </Link>
                    </CardFooter>
                  </Card>
                </div>
                ))
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

interface ProductHistoryScan {
  id: string;
  scanNumber: string;
  complianceStatus: string | null;
  complianceScore: number | string | null;
  reviewStatus: string | null;
  location: string | null;
  createdAt: string;
}

interface ProductDetailResponse {
  product: Product;
  totalInspections: number;
  history: ProductHistoryScan[];
}
