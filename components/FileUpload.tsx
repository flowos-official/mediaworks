'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Upload, FileText, Image, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
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
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => !uploading && fileInputRef.current?.click()}
        className={cn(
          'relative border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-all duration-200',
          isDragging
            ? 'border-blue-400 bg-blue-50'
            : 'border-gray-300 bg-white hover:border-blue-400 hover:bg-blue-50/30',
          uploading && 'cursor-not-allowed opacity-70'
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept=".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.gif,.webp"
          onChange={onFileChange}
          disabled={uploading}
        />

        <div className="flex flex-col items-center gap-4">
          {uploading ? (
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center">
              <Loader2 size={32} className="text-blue-600 animate-spin" />
            </div>
          ) : (
            <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center">
              <Upload size={32} className="text-blue-600" />
            </div>
          )}

          <div>
            <p className="text-lg font-semibold text-gray-800">
              {uploading
                ? locale === 'ja'
                  ? `${uploadCount}件のファイルをアップロード中...`
                  : `Uploading ${uploadCount} file(s)...`
                : t('uploadTitle')}
            </p>
            {!uploading && (
              <p className="text-sm text-gray-500 mt-1">{t('uploadDescription')}</p>
            )}
          </div>

          {!uploading && (
            <div className="flex items-center gap-4 text-xs text-gray-400">
              <span className="flex items-center gap-1">
                <FileText size={12} /> PDF, PPT, DOCX, XLS
              </span>
              <span className="flex items-center gap-1">
                <Image size={12} /> JPG, PNG
              </span>
            </div>
          )}
        </div>
      </div>

      {status === 'success' && (
        <div className="mt-3 flex items-center gap-2 text-green-600 text-sm bg-green-50 px-4 py-2 rounded-lg">
          <CheckCircle size={16} />
          {statusMsg}
        </div>
      )}
      {status === 'error' && (
        <div className="mt-3 flex items-center gap-2 text-red-600 text-sm bg-red-50 px-4 py-2 rounded-lg">
          <AlertCircle size={16} />
          {statusMsg}
        </div>
      )}
    </div>
  );
}
