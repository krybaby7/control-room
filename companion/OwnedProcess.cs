using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

// Original process ownership helper. A Job Object is a process lifetime boundary,
// not a filesystem/network sandbox. Provider-native sandbox policy is independent.
public class CompanionOwnedProcess {
 const uint CREATE_SUSPENDED=4, CREATE_UNICODE_ENVIRONMENT=0x400, CREATE_NO_WINDOW=0x08000000, STARTF_USESTDHANDLES=0x100, EXTENDED_STARTUPINFO_PRESENT=0x80000;
 const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE=0x2000, HANDLE_FLAG_INHERIT=1;
 [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO {public int cb;public string? lpReserved,lpDesktop,lpTitle;public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags;public short wShowWindow,cbReserved2;public IntPtr lpReserved2,hStdInput,hStdOutput,hStdError;}
 [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {public STARTUPINFO StartupInfo;public IntPtr lpAttributeList;}
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {public IntPtr hProcess,hThread;public uint dwProcessId,dwThreadId;}
 [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {public long PerProcessUserTimeLimit,PerJobUserTimeLimit;public uint LimitFlags;public UIntPtr MinimumWorkingSetSize,MaximumWorkingSetSize;public uint ActiveProcessLimit;public UIntPtr Affinity;public uint PriorityClass,SchedulingClass;}
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {public ulong ReadOperationCount,WriteOperationCount,OtherOperationCount,ReadTransferCount,WriteTransferCount,OtherTransferCount;}
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {public BASIC_LIMIT BasicLimitInformation;public IO_COUNTERS IoInfo;public UIntPtr ProcessMemoryLimit,JobMemoryLimit,PeakProcessMemoryUsed,PeakJobMemoryUsed;}
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {public long TotalUserTime,TotalKernelTime,ThisPeriodTotalUserTime,ThisPeriodTotalKernelTime;public uint TotalPageFaultCount,TotalProcesses,ActiveProcesses,TotalTerminatedProcesses;}
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes,string? name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,ref EXTENDED_LIMIT data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,out ACCOUNTING data,uint size,IntPtr length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SECURITY_ATTRIBUTES attributes,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr environment,string directory,ref STARTUPINFOEX startup,out PROCESS_INFORMATION process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref UIntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 static readonly object OutputLock=new();
 static void Emit(object data){lock(OutputLock){Console.Out.WriteLine(JsonSerializer.Serialize(data));Console.Out.Flush();}}
 static void Check(bool success){if(!success)throw new Win32Exception(Marshal.GetLastWin32Error());}
 static string Quote(string value){if(value.Length>0&&!value.Any(c=>char.IsWhiteSpace(c)||c=='"'))return value;var b=new StringBuilder("\"");int slash=0;foreach(char c in value){if(c=='\\'){slash++;continue;}if(c=='"'){b.Append('\\',slash*2+1);b.Append('"');}else{b.Append('\\',slash);b.Append(c);}slash=0;}b.Append('\\',slash*2);return b.Append('"').ToString();}
 static async Task Pump(IntPtr handle,string kind){using var stream=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read,8192,false);var buffer=new byte[8192];for(;;){int count=await stream.ReadAsync(buffer);if(count==0)break;Emit(new{kind,data=Convert.ToBase64String(buffer,0,count)});}}
 public static async Task<int> Main(){
  if(!OperatingSystem.IsWindows())return 2;
  Console.InputEncoding=new UTF8Encoding(false,true);Console.OutputEncoding=new UTF8Encoding(false,true);
  IntPtr attributes=IntPtr.Zero,handleList=IntPtr.Zero;bool attributesReady=false;
  IntPtr job=IntPtr.Zero,environment=IntPtr.Zero,inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,errorRead=IntPtr.Zero,errorWrite=IntPtr.Zero;PROCESS_INFORMATION process=default;bool assigned=false;
  try{
   string? line=await Console.In.ReadLineAsync();if(line==null||line.Length>1048576)return 2;using var json=JsonDocument.Parse(line);var r=json.RootElement;
   string executable=r.GetProperty("executable").GetString()!,cwd=r.GetProperty("cwd").GetString()!,input=r.GetProperty("input").GetString()!;
   if(!Path.IsPathFullyQualified(executable)||!Path.IsPathFullyQualified(cwd)||!File.Exists(executable)||executable.Contains('\0')||cwd.Contains('\0'))return 2;
   var args=r.GetProperty("args").EnumerateArray().Select(v=>v.GetString()!).ToArray();if(args.Length>128||args.Any(v=>v==null||v.Contains('\0'))||Encoding.UTF8.GetByteCount(input)>240000)return 2;
   int timeout=r.GetProperty("timeoutMs").GetInt32();if(timeout<1||timeout>600000)return 2;
   var env=r.GetProperty("env").EnumerateObject().OrderBy(v=>v.Name,StringComparer.OrdinalIgnoreCase).ToArray();if(env.Length>256||env.Any(v=>v.Name.Contains('=')||v.Name.Contains('\0')||v.Value.GetString()!.Contains('\0')))return 2;
   string block=string.Join('\0',env.Select(v=>v.Name+"="+v.Value.GetString()))+"\0\0";environment=Marshal.StringToHGlobalUni(block);
   job=CreateJobObjectW(IntPtr.Zero,null);Check(job!=IntPtr.Zero);var limits=new EXTENDED_LIMIT{BasicLimitInformation=new BASIC_LIMIT{LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|0x8,ActiveProcessLimit=1}};Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf<EXTENDED_LIMIT>()));
   var sa=new SECURITY_ATTRIBUTES{nLength=Marshal.SizeOf<SECURITY_ATTRIBUTES>(),bInheritHandle=true};Check(CreatePipe(out inputRead,out inputWrite,ref sa,0));Check(CreatePipe(out outputRead,out outputWrite,ref sa,0));Check(CreatePipe(out errorRead,out errorWrite,ref sa,0));Check(SetHandleInformation(inputWrite,HANDLE_FLAG_INHERIT,0));Check(SetHandleInformation(outputRead,HANDLE_FLAG_INHERIT,0));Check(SetHandleInformation(errorRead,HANDLE_FLAG_INHERIT,0));
   UIntPtr attributeSize=UIntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attributeSize);attributes=Marshal.AllocHGlobal(checked((int)attributeSize.ToUInt64()));Check(InitializeProcThreadAttributeList(attributes,1,0,ref attributeSize));attributesReady=true;
   handleList=Marshal.AllocHGlobal(IntPtr.Size*3);Marshal.Copy(new[]{inputRead,outputWrite,errorWrite},0,handleList,3);Check(UpdateProcThreadAttribute(attributes,0,(UIntPtr)0x20002,handleList,(UIntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
   var startup=new STARTUPINFOEX{StartupInfo=new STARTUPINFO{cb=Marshal.SizeOf<STARTUPINFOEX>(),dwFlags=STARTF_USESTDHANDLES,hStdInput=inputRead,hStdOutput=outputWrite,hStdError=errorWrite},lpAttributeList=attributes};
   var command=new StringBuilder(string.Join(' ',new[]{executable}.Concat(args).Select(Quote)));Check(CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,environment,cwd,ref startup,out process));
   Check(AssignProcessToJobObject(job,process.hProcess));assigned=true;
   CloseHandle(inputRead);inputRead=IntPtr.Zero;CloseHandle(outputWrite);outputWrite=IntPtr.Zero;CloseHandle(errorWrite);errorWrite=IntPtr.Zero;
   Emit(new{kind="started",pid=process.dwProcessId,startedAt=DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")});
   // Provider cannot execute one instruction before the durable owner acknowledgement.
   var ackTask=Task.Run(()=>Console.In.ReadLine());if(await Task.WhenAny(ackTask,Task.Delay(15000))!=ackTask||await ackTask!="resume")throw new InvalidOperationException();
   var outTask=Pump(outputRead,"stdout");outputRead=IntPtr.Zero;var errTask=Pump(errorRead,"stderr");errorRead=IntPtr.Zero;
   Check(ResumeThread(process.hThread)!=uint.MaxValue);CloseHandle(process.hThread);process.hThread=IntPtr.Zero;
   var writer=new FileStream(new SafeFileHandle(inputWrite,true),FileAccess.Write);inputWrite=IntPtr.Zero;
   var inputTask=Task.Run(async()=>{try{await writer.WriteAsync(Encoding.UTF8.GetBytes(input));}catch(IOException){}finally{writer.Dispose();}});
   var stop=Task.Run(()=>Console.In.ReadLine());var watch=Stopwatch.StartNew();bool stopping=false;long stoppedAt=0;
   for(;;){Check(QueryInformationJobObject(job,1,out var accounting,(uint)Marshal.SizeOf<ACCOUNTING>(),IntPtr.Zero));if(accounting.ActiveProcesses==0)break;
    if(!stopping&&(stop.IsCompleted||watch.ElapsedMilliseconds>=timeout)){Check(TerminateJobObject(job,1));stopping=true;stoppedAt=watch.ElapsedMilliseconds;}
    if(stopping&&watch.ElapsedMilliseconds-stoppedAt>10000){Emit(new{kind="uncertain"});return 3;}await Task.Delay(20);
   }
   Check(GetExitCodeProcess(process.hProcess,out uint exit));await Task.WhenAll(outTask,errTask,inputTask);Emit(new{kind="exited",exitCode=unchecked((int)exit),processExitConfirmed=true});return 0;
  }catch{Emit(new{kind="uncertain"});return 3;}
  finally{
   if(process.hProcess!=IntPtr.Zero&&!assigned)TerminateProcess(process.hProcess,1);
   if(job!=IntPtr.Zero)CloseHandle(job); // also kills all descendants if helper fails/crashes
   foreach(var h in new[]{process.hThread,process.hProcess,inputRead,inputWrite,outputRead,outputWrite,errorRead,errorWrite})if(h!=IntPtr.Zero)CloseHandle(h);
   if(attributesReady)DeleteProcThreadAttributeList(attributes);if(attributes!=IntPtr.Zero)Marshal.FreeHGlobal(attributes);if(handleList!=IntPtr.Zero)Marshal.FreeHGlobal(handleList);
   if(environment!=IntPtr.Zero)Marshal.FreeHGlobal(environment);
  }
 }
}
