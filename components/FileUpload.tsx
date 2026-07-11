'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Upload, FileText, ImageIcon, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FileUploadProps {
  onUploadComplete: () => void;
}

const ACCEPTED = [
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
];

const ACCEPTED_EXTENSIONS = new Set([
  '.pdf', '.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx',
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
]);

export default function FileUpload({ onUploadComplete }: FileUploadProps) {
  const t = useTranslations('home');
  const locale = useLocale();
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((f) => {
      if (ACCEPTED.includes(f.type)) return true;
      const ext = f.name.match(/\.[^.]+$/)?.[0]?.toLowerCase();
      return ext ? ACCEPTED_EXTENSIONS.has(ext) : false;
    });

    if (files.length === 0) {
      setStatus('error');
      setStatusMsg(
        locale === 'ja'
          ? 'サポートされていないファイル形式です'
          : 'Unsupported file type'
      );
      return;
    }

    setUploading(true);
    setUploadCount(files.length);
    setStatus('idle');

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file);
      }
      formData.append('locale', locale);

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error('Upload failed');

      const data = await res.json();
      setStatus('success');
      setStatusMsg(
        locale === 'ja'
          ? `${data.filesUploaded}件のファイルをアップロードしました`
          : `${data.filesUploaded} file(s) uploaded successfully`
      );
      onUploadComplete();
    } catch {
      setStatus('error');
      setStatusMsg(
        locale === 'ja'
          ? 'アップロードに失敗しました。もう一度お試しください。'
          : 'Upload failed. Please try again.'
      );
    } finally {
      setUploading(false);
      setUploadCount(0);
    }
  }, [locale, onUploadComplete]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles]
  );

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => setIsDragging(false);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
    }
  };

  return (
    <div className="w-full">
      <div
        role="button"
        tabIndex={0}
        aria-label={locale === 'ja' ? 'ファイルをアップロード' : 'Upload files'}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => !uploading && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (uploading) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className={cn(
          'relative overflow-hidden rounded-2xl border border-dashed p-5 text-left cursor-pointer transition-all duration-200 sm:p-6',
          isDragging
            ? 'border-primary bg-primary/10 shadow-[inset_0_0_0_1px_rgba(37,99,235,0.12)]'
            : 'border-border bg-card hover:border-primary/45 hover:bg-primary/[0.035]',
          uploading && 'cursor-not-allowed opacity-70'
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          aria-label={locale === 'ja' ? 'アップロードするファイルを選択' : 'Choose files to upload'}
          multiple
          className="hidden"
          accept=".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp"
          onChange={onFileChange}
          disabled={uploading}
        />

        <span className="absolute inset-y-0 left-0 w-1 bg-primary" aria-hidden="true" />
        <div className="grid items-center gap-4 sm:grid-cols-[auto_1fr_auto] sm:gap-5">
          {uploading ? (
            <div className="flex size-12 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
              <Loader2 size={22} className="animate-spin text-primary" />
            </div>
          ) : (
            <div className="flex size-12 items-center justify-center rounded-xl border border-primary/20 bg-primary/10">
              <Upload size={22} className="text-primary" />
            </div>
          )}

          <div className="min-w-0">
            <div className="mw-kicker mb-1">Research intake</div>
            <p className="text-base font-semibold tracking-[-0.01em] text-foreground sm:text-lg">
              {uploading
                ? locale === 'ja'
                  ? `${uploadCount}件のファイルをアップロード中...`
                  : `Uploading ${uploadCount} file(s)...`
                : t('uploadTitle')}
            </p>
            {!uploading && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">{t('uploadDescription')}</p>
            )}
          </div>

          {!uploading && (
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground sm:justify-end">
              <span className="flex items-center gap-1">
                <FileText size={11} /> PDF · PPT · DOCX · XLS
              </span>
              <span className="flex items-center gap-1">
                <ImageIcon size={11} /> JPG · PNG
              </span>
              <span className="w-full rounded-lg border border-border bg-background px-3 py-2 text-center text-xs font-semibold text-foreground sm:w-auto">
                {locale === 'ja' ? 'ファイルを選択' : 'Choose files'}
              </span>
            </div>
          )}
        </div>
      </div>

      {status === 'success' && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          <CheckCircle size={16} />
          {statusMsg}
        </div>
      )}
      {status === 'error' && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-700 dark:text-red-300">
          <AlertCircle size={16} />
          {statusMsg}
        </div>
      )}
    </div>
  );
}
