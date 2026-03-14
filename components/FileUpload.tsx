'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Upload, FileText, Image, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FileUploadProps {
  onUploadComplete: () => void;
}

export default function FileUpload({ onUploadComplete }: FileUploadProps) {
  const t = useTranslations('home');
  const locale = useLocale();
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ACCEPTED = [
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ];

  const handleFile = async (file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      setStatus('error');
      setStatusMsg(locale === 'ja' ? 'サポートされていないファイル形式です' : 'Unsupported file type');
      return;
    }

    setUploading(true);
    setStatus('idle');

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('locale', locale); // ← pass locale to upload API

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error('Upload failed');

      setStatus('success');
      setStatusMsg(t('uploadSuccess'));
      onUploadComplete();
    } catch {
      setStatus('error');
      setStatusMsg(
        locale === 'ja' ? 'アップロードに失敗しました。もう一度お試しください。' : 'Upload failed. Please try again.'
      );
    } finally {
      setUploading(false);
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [locale]);

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => setIsDragging(false);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
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
          className="hidden"
          accept=".pdf,.ppt,.pptx,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp"
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
              {uploading ? t('analyzing') : t('uploadTitle')}
            </p>
            {!uploading && (
              <p className="text-sm text-gray-500 mt-1">{t('uploadDescription')}</p>
            )}
          </div>

          {!uploading && (
            <div className="flex items-center gap-4 text-xs text-gray-400">
              <span className="flex items-center gap-1">
                <FileText size={12} /> PDF, PPT, DOCX
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
